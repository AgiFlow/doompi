import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealtimeRuntime } from '../src/services/realtimeRuntime';

const roots: string[] = [];
const signal = new AbortController().signal;
const idToken = `e30.${Buffer.from(
  JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } }),
).toString('base64url')}.signature`;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doompi-realtime-runtime-'));
  roots.push(root);
  return root;
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({ id_token: idToken, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }),
    { status: 200 },
  );
}

function authDocument(): string {
  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    doompi_auth_owner: 'doompi',
    tokens: {
      id_token: idToken,
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      account_id: 'synthetic-account',
    },
  })}\n`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('realtime host runtime', () => {
  it('is lazy and completes an explicit loopback sign-in into private DoomPi-only storage', async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse());
    const runtime = createRealtimeRuntime({
      stateDirectory: root,
      fetch: fetchImpl,
      callbackPort: 0,
      loginTimeoutMs: 5_000,
      now: () => new Date(0),
    });
    expect(await readdir(root)).toEqual([]);

    const signIn = await runtime.signIn();
    const authorize = new URL(signIn.authorizationUrl);
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('localhost');
    expect(redirect.pathname).toBe('/auth/callback');
    expect(Number(redirect.port)).toBeGreaterThan(0);

    const invalid = await fetch(`${redirect.toString()}?code=ignored&state=wrong`);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('ignored');
    expect(fetchImpl).not.toHaveBeenCalled();

    const state = authorize.searchParams.get('state')!;
    const callback = await fetch(`${redirect.toString()}?code=synthetic-code&state=${encodeURIComponent(state)}`);
    expect(callback.status).toBe(200);
    const callbackBody = await callback.text();
    expect(callbackBody).not.toContain('synthetic-code');
    expect(callbackBody).not.toContain('synthetic-access');
    await signIn.completion;

    await expect(runtime.auth.credentials(signal)).resolves.toEqual({
      accessToken: 'synthetic-access',
      accountId: 'synthetic-account',
    });
    const directory = join(root, 'voice', 'subscription-auth');
    const authPath = join(directory, 'auth.json');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not enter through another process lock or remove that lock', async () => {
    const root = await temporaryRoot();
    const directory = join(root, 'voice', 'subscription-auth');
    const lockPath = join(directory, 'auth.lock');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'auth.json'), authDocument(), { mode: 0o600 });
    await mkdir(lockPath);
    const fetchImpl = vi.fn<typeof fetch>();
    const runtime = createRealtimeRuntime({
      stateDirectory: root,
      fetch: fetchImpl,
      lockAttempts: 1,
      lockRetryMs: 0,
      operationTimeoutMs: 5_000,
    });

    await expect(runtime.auth.refresh(signal)).rejects.toMatchObject({ code: 'auth_lock_timeout' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it('releases only its acquired lock when refresh is cancelled', async () => {
    const root = await temporaryRoot();
    const directory = join(root, 'voice', 'subscription-auth');
    const lockPath = join(directory, 'auth.lock');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'auth.json'), authDocument(), { mode: 0o600 });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      requestStarted();
      // The runtime's pinned fetch boundary must still release the owned lock.
      return new Promise<Response>(() => undefined);
    });
    const runtime = createRealtimeRuntime({ stateDirectory: root, fetch: fetchImpl, operationTimeoutMs: 5_000 });
    const controller = new AbortController();
    const refresh = runtime.auth.refresh(controller.signal);
    await started;
    await expect(stat(lockPath)).resolves.toBeDefined();
    controller.abort();
    await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds cancellation and closes the callback listener socket', async () => {
    const root = await temporaryRoot();
    const runtime = createRealtimeRuntime({
      stateDirectory: root,
      fetch: vi.fn(),
      callbackPort: 0,
      loginTimeoutMs: 5_000,
    });
    const signIn = await runtime.signIn();
    const redirect = new URL(new URL(signIn.authorizationUrl).searchParams.get('redirect_uri')!);
    signIn.cancel();
    await expect(signIn.completion).rejects.toMatchObject({ code: 'login_cancelled' });

    const replacement = createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen({ host: 'localhost', port: Number(redirect.port), exclusive: true }, resolve);
    });
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });

  it('times out sign-in and closes the callback listener socket', async () => {
    const root = await temporaryRoot();
    const runtime = createRealtimeRuntime({
      stateDirectory: root,
      fetch: vi.fn(),
      callbackPort: 0,
      loginTimeoutMs: 20,
    });
    const signIn = await runtime.signIn();
    const redirect = new URL(new URL(signIn.authorizationUrl).searchParams.get('redirect_uri')!);
    await expect(signIn.completion).rejects.toMatchObject({ code: 'login_timeout' });

    const replacement = createServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen({ host: 'localhost', port: Number(redirect.port), exclusive: true }, resolve);
    });
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  });
});
