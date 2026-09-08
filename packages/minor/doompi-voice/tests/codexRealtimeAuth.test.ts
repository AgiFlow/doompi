/*
 * Tests for the TypeScript port of OpenAI Codex authentication at commit 5ecb3afd1b.
 * Copyright OpenAI. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createCodexFileAuthStorage,
  createCodexRealtimeAuth,
  type CodexAuthTransaction,
  type CodexOwnedAuthStorage,
} from '../src/adapters/realtime/codexAuth.ts';

const signal = new AbortController().signal;
const idToken = 'e30.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NvdW50LTEifQ.signature';
const initial = {
  auth_mode: 'chatgpt',
  doompi_auth_owner: 'doompi',
  tokens: { id_token: idToken, access_token: 'access-1', refresh_token: 'refresh-1', account_id: 'account-1' },
  retained: true,
};

class MemoryStorage implements CodexOwnedAuthStorage {
  raw = JSON.stringify(initial);
  tail = Promise.resolve();

  async read(): Promise<string> {
    return this.raw;
  }

  async runExclusive<T>(
    _signal: AbortSignal,
    operation: (transaction: CodexAuthTransaction) => Promise<T>,
  ): Promise<T> {
    const result = this.tail.then(() =>
      operation({ read: () => this.read(), write: async (value) => void (this.raw = value) }),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

describe('DoomPi-owned Codex subscription auth', () => {
  it('loads only DoomPi-owned subscription credentials', async () => {
    const auth = createCodexRealtimeAuth({ storage: new MemoryStorage(), fetch: vi.fn(), now: () => new Date(0) });
    await expect(auth.credentials(signal)).resolves.toEqual({ accessToken: 'access-1', accountId: 'account-1' });
  });

  it('rejects a native shared credential document', async () => {
    const storage = new MemoryStorage();
    storage.raw = JSON.stringify({ auth_mode: 'chatgpt', tokens: initial.tokens });
    const auth = createCodexRealtimeAuth({ storage, fetch: vi.fn(), now: () => new Date(0) });
    await expect(auth.credentials(signal)).rejects.toMatchObject({ code: 'auth_owner_unsupported' });
  });

  it.each([
    [null, 'auth_missing'],
    ['not-json', 'auth_document_invalid'],
    [JSON.stringify({ doompi_auth_owner: 'doompi', auth_mode: 'apikey' }), 'auth_mode_unsupported'],
    [JSON.stringify({ doompi_auth_owner: 'doompi', auth_mode: 'chatgpt' }), 'auth_tokens_missing'],
    [
      JSON.stringify({
        doompi_auth_owner: 'doompi',
        auth_mode: 'chatgpt',
        tokens: { access_token: '', account_id: 'account-1' },
      }),
      'auth_tokens_invalid',
    ],
  ])('rejects invalid owned credential documents', async (raw, code) => {
    const storage = new MemoryStorage();
    storage.raw = raw as string;
    if (raw === null) storage.read = async () => null as never;
    const auth = createCodexRealtimeAuth({ storage, fetch: vi.fn(), now: () => new Date(0) });
    await expect(auth.credentials(signal)).rejects.toMatchObject({ code });
  });

  it('serializes refresh through the owned store lock and rotates tokens', async () => {
    const storage = new MemoryStorage();
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      const refreshToken = JSON.parse(init.body).refresh_token as string;
      seen.push(refreshToken);
      return response({ access_token: `access-${seen.length + 1}`, refresh_token: `refresh-${seen.length + 1}` });
    });
    const authA = createCodexRealtimeAuth({ storage, fetch: fetchImpl, now: () => new Date(0) });
    const authB = createCodexRealtimeAuth({ storage, fetch: fetchImpl, now: () => new Date(0) });
    await Promise.all([authA.refresh(signal), authB.refresh(signal)]);
    expect(seen).toEqual(['refresh-1', 'refresh-2']);
    expect(JSON.parse(storage.raw).tokens.refresh_token).toBe('refresh-3');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://auth.openai.com/oauth/token');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('allows an aborted lock waiter to stop without waiting for the holder', async () => {
    const controller = new AbortController();
    const storage: CodexOwnedAuthStorage = {
      read: async () => JSON.stringify(initial),
      runExclusive: async (lockSignal) =>
        new Promise((_resolve, reject) => lockSignal.addEventListener('abort', () => reject(lockSignal.reason))),
    };
    const auth = createCodexRealtimeAuth({ storage, fetch: vi.fn(), now: () => new Date(0) });
    const pending = auth.refresh(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exposes native Codex file storage as read-only', async () => {
    const storage = createCodexFileAuthStorage({
      authFilePath: '/shared/auth.json',
      readFile: async () => JSON.stringify(initial),
    });
    await expect(storage.read(signal)).resolves.toContain('access-1');
    expect(storage).not.toHaveProperty('runExclusive');
  });

  it('rejects redirected refresh responses', async () => {
    const redirected = response({}, { status: 302, headers: { location: 'https://evil.example' } });
    const auth = createCodexRealtimeAuth({
      storage: new MemoryStorage(),
      fetch: vi.fn().mockResolvedValue(redirected),
      now: () => new Date(0),
    });
    await expect(auth.refresh(signal)).rejects.toMatchObject({ code: 'refresh_failed' });
  });

  it('rejects invalid operation timeouts before storage access', async () => {
    const storage = new MemoryStorage();
    const read = vi.spyOn(storage, 'read');
    const auth = createCodexRealtimeAuth({ storage, fetch: vi.fn(), now: () => new Date(0), operationTimeoutMs: 0 });
    await expect(auth.credentials(signal)).rejects.toMatchObject({ code: 'timeout_invalid' });
    expect(read).not.toHaveBeenCalled();
  });

  it('classifies rejected refresh tokens without exposing provider details', async () => {
    const auth = createCodexRealtimeAuth({
      storage: new MemoryStorage(),
      fetch: vi
        .fn()
        .mockResolvedValue(response({ error: { code: 'refresh_token_reused', message: 'secret' } }, { status: 401 })),
      now: () => new Date(0),
    });
    const error = await auth.refresh(signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'refresh_token_reused' });
    expect(String(error)).not.toContain('secret');
  });
});
