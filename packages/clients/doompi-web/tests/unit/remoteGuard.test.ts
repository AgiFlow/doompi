import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRemoteGuard } from '../../src/adapters/remoteGuard.ts';
import { tunnelOriginPolicy } from '../../src/services/remoteGuardPolicy.ts';
import { STEP_UP_HEADER } from '../../src/types/remoteAccess.ts';

const LOOPBACK = 7433;
const TUNNEL_ORIGIN = 'https://doom.example.com';

interface FakeRequest {
  port?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

/** The slice of a Hono context the guard actually reads. */
function context(request: FakeRequest): Context {
  const headers: Record<string, string> = {
    host: request.port === LOOPBACK ? `127.0.0.1:${String(LOOPBACK)}` : 'doom.example.com',
    ...request.headers,
  };
  return {
    env: request.port === undefined ? {} : { incoming: { socket: { localPort: request.port } } },
    req: {
      method: request.method ?? 'GET',
      path: request.path ?? '/api/health',
      header: (name: string) => headers[name.toLowerCase()],
    },
    text: (body: string, status: number) => ({ body, status }),
    json: (body: unknown, status: number) => ({ body, status }),
  } as unknown as Context;
}

function guardWith(overrides: Partial<Parameters<typeof createRemoteGuard>[0]> = {}) {
  return createRemoteGuard({
    loopbackPort: () => LOOPBACK,
    tunnelPolicy: () => tunnelOriginPolicy(TUNNEL_ORIGIN),
    authorize: () => 'device',
    channelReady: () => true,
    ...overrides,
  });
}

function sealedGuardWith(overrides: Partial<Parameters<typeof createRemoteGuard>[0]> = {}) {
  return guardWith({ trustedDevice: () => 'device', ...overrides });
}

async function run(guard: ReturnType<typeof createRemoteGuard>, request: FakeRequest) {
  let passed = false;
  const requestContext = context(request);
  const answer = await guard.middleware(requestContext, async () => {
    passed = true;
  });
  return {
    passed,
    answer: answer as unknown as { status?: number; body?: unknown } | undefined,
    caller: guard.callerOf(requestContext),
  };
}

describe('the guard on the loopback listener', () => {
  it('lets a local request through and stamps it as local without claiming user presence', async () => {
    const result = await run(guardWith(), { port: LOOPBACK });
    expect(result.passed).toBe(true);
    expect(result.caller).toEqual({ locality: 'local', stepUp: 'not-required' });
  });

  it('refuses a hostile origin', async () => {
    const { passed, answer } = await run(guardWith(), {
      port: LOOPBACK,
      headers: { origin: 'https://evil.example', upgrade: 'websocket' },
    });
    expect(passed).toBe(false);
    expect(answer?.status).toBe(403);
  });

  it('never consults the device store for a local caller', async () => {
    let asked = false;
    const guard = guardWith({
      authorize: () => {
        asked = true;
        return undefined;
      },
    });
    expect((await run(guard, { port: LOOPBACK })).passed).toBe(true);
    expect(asked).toBe(false);
  });
});

describe('the guard on the tunnel listener', () => {
  it('refuses an unpaired caller', async () => {
    const guard = guardWith({ authorize: () => undefined });
    const { passed, answer } = await run(guard, { port: 65_000, headers: { origin: TUNNEL_ORIGIN } });
    expect(passed).toBe(false);
    expect(answer?.status).toBe(401);
  });

  it('lets the pairing routes through unauthenticated', async () => {
    const guard = guardWith({ authorize: () => undefined });
    expect((await run(guard, { port: 65_000, path: '/pair' })).passed).toBe(true);
  });

  it('fails closed when the socket port cannot be read', async () => {
    // A request the guard cannot place is treated as remote, which is the safe
    // direction to be wrong in.
    const guard = guardWith({ authorize: () => undefined });
    expect((await run(guard, { port: undefined, headers: { origin: TUNNEL_ORIGIN } })).passed).toBe(false);
  });

  it('serves nothing before the tunnel has named itself', async () => {
    const guard = guardWith({ tunnelPolicy: () => undefined });
    const { passed, answer } = await run(guard, { port: 65_000, path: '/pair' });
    expect(passed).toBe(false);
    expect(answer?.status).toBe(403);
  });

  it.each(['/api/session', '/api/pi'])('refuses %s before its sealed channel exists', async (path) => {
    const guard = guardWith({ channelReady: () => false });
    const { passed, answer } = await run(guard, {
      port: 65_000,
      path,
      headers: { origin: TUNNEL_ORIGIN, upgrade: 'websocket' },
    });
    expect(passed).toBe(false);
    expect(answer?.status).toBe(401);
  });

  it('refuses direct HTTP even when the relay presents a paired cookie', async () => {
    const { passed, answer } = await run(guardWith(), {
      port: 65_000,
      path: '/api/health',
      headers: { origin: TUNNEL_ORIGIN },
    });
    expect(passed).toBe(false);
    expect(answer?.status).toBe(401);
    expect(answer?.body).toMatchObject({ error: 'Remote HTTP requests must use the sealed gateway.' });
  });

  it('allows paired static assets needed to bootstrap the sealed client', async () => {
    const { passed } = await run(guardWith(), {
      port: 65_000,
      path: '/assets/cockpit.js',
      headers: { origin: TUNNEL_ORIGIN },
    });
    expect(passed).toBe(true);
  });
});

describe('the step-up gate', () => {
  const gated: FakeRequest = {
    port: 65_000,
    method: 'POST',
    path: '/api/sessions',
    headers: { origin: TUNNEL_ORIGIN },
  };

  it('demands a gesture for a gated action', async () => {
    const guard = sealedGuardWith({ stepUp: { required: () => true, verify: async () => true } });
    const { passed, answer } = await run(guard, gated);
    expect(passed).toBe(false);
    expect(answer?.status).toBe(401);
    expect(answer?.body).toMatchObject({ action: 'session.create' });
  });

  it('accepts a valid assertion and records the verified outcome', async () => {
    const assertion = Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url');
    const guard = sealedGuardWith({ stepUp: { required: () => true, verify: async () => true } });
    const result = await run(guard, { ...gated, headers: { ...gated.headers, [STEP_UP_HEADER]: assertion } });
    expect(result.passed).toBe(true);
    expect(result.caller).toEqual({ locality: 'remote', deviceId: 'device', stepUp: 'verified' });
  });

  it('refuses an assertion the server rejects', async () => {
    const assertion = Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url');
    const guard = sealedGuardWith({ stepUp: { required: () => true, verify: async () => false } });
    const { passed } = await run(guard, { ...gated, headers: { ...gated.headers, [STEP_UP_HEADER]: assertion } });
    expect(passed).toBe(false);
  });

  it('refuses a malformed assertion header without throwing', async () => {
    const guard = sealedGuardWith({ stepUp: { required: () => true, verify: async () => true } });
    const { passed } = await run(guard, { ...gated, headers: { ...gated.headers, [STEP_UP_HEADER]: '!!!not base64' } });
    expect(passed).toBe(false);
  });

  it('keeps quick tunnels usable and records that step-up was unavailable', async () => {
    // A quick tunnel has no stable relying party, so there is no gesture to
    // demand and demanding one would lock the phone out entirely.
    const guard = sealedGuardWith({ stepUp: { required: () => false, verify: async () => false } });
    const result = await run(guard, gated);
    expect(result.passed).toBe(true);
    expect(result.caller).toEqual({ locality: 'remote', deviceId: 'device', stepUp: 'unavailable' });
  });

  it('leaves ordinary work ungated', async () => {
    const guard = sealedGuardWith({ stepUp: { required: () => true, verify: async () => false } });
    const { passed } = await run(guard, { port: 65_000, path: '/api/health', headers: { origin: TUNNEL_ORIGIN } });
    expect(passed).toBe(true);
  });
});
