import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerRemoteRoutes } from '../../../../src/server/remoteRoutes';
import type { RemoteAccess } from '../../../../src/services/remoteAccess';

function fixture() {
  const passkeys = {
    support: vi.fn(() => ({ supported: true, rpId: 'access.example.com' })),
    list: vi.fn(() => [{ id: 'key-1', label: 'Phone', createdAt: 1000, lastUsedAt: 2000 }]),
    beginRegistration: vi.fn(async () => ({ ceremonyId: 'reg-1', options: { challenge: 'reg' } })),
    finishRegistration: vi.fn(async () => ({ ok: true, id: 'key-2' })),
    beginAuthentication: vi.fn(async () => ({ ceremonyId: 'auth-1', options: { challenge: 'auth' } })),
    finishAuthentication: vi.fn(async () => ({ ok: true, credential: { label: 'Phone' } })),
    beginStepUp: vi.fn(async () => ({ ceremonyId: 'step-1', options: { challenge: 'step' } })),
    finishStepUp: vi.fn(async () => true),
    forget: vi.fn(() => true),
  };
  const remote = {
    bundleTrust: vi.fn(() => ({ publicKey: 'bundle-key', revision: 1, fingerprint: 'fingerprint' })),
    channelPublicKey: vi.fn(() => 'channel-key'),
    claim: vi.fn(() => ({ ok: true, requestId: 'request-1' })),
    pairingStatus: vi.fn(() => 'pending'),
    redeem: vi.fn(() => ({ token: 'device-token', maxAgeSeconds: 60 })),
    authorize: vi.fn(() => undefined),
    state: vi.fn(() => ({ enabled: true })),
    enable: vi.fn(async () => ({ ok: true })),
    disable: vi.fn(async () => undefined),
    handoverPending: vi.fn(() => false),
    commitHandover: vi.fn(),
    mintPairing: vi.fn(() => ({ code: 'qr', manualCode: '123456', pairUrl: 'https://example.com', expiresAt: 'soon' })),
    approve: vi.fn(() => 'approved'),
    deny: vi.fn(() => 'denied'),
    revokeDevice: vi.fn(() => true),
    passkeys: vi.fn(() => passkeys),
    sessionForPasskey: vi.fn(() => ({ token: 'passkey-token', maxAgeSeconds: 60 })),
    openChannel: vi.fn(() => true),
    updateSettings: vi.fn(() => ({ enabled: true })),
  };
  const app = new Hono();
  registerRemoteRoutes(app, {
    remote: remote as unknown as RemoteAccess,
    listenerOf: (context) => (context.env as { listener: 'local' | 'tunnel' }).listener,
  });
  const request = (
    method: string,
    path: string,
    body?: unknown,
    listener: 'local' | 'tunnel' = 'local',
    headers: Record<string, string> = {},
  ) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    return app.request(new Request(`http://localhost${path}`, init), undefined, {
      listener,
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
    });
  };
  return { remote, passkeys, request };
}

describe('remote routes', () => {
  it('validates pairing claims and uses the trusted tunnel edge address for throttling', async () => {
    const { request, remote } = fixture();
    expect((await request('POST', '/api/remote/pair', 'not-json')).status).toBe(400);
    expect((await request('POST', '/api/remote/pair', { code: '' })).status).toBe(400);
    const claimed = await request('POST', '/api/remote/pair', { code: '123456' }, 'tunnel', {
      'cf-connecting-ip': '192.0.2.10',
      'user-agent': 'Phone',
    });
    expect(claimed.status).toBe(202);
    expect(await claimed.json()).toEqual({ requestId: 'request-1', status: 'pending' });
    expect(remote.claim).toHaveBeenCalledWith(expect.objectContaining({ sourceAddress: 'cloudflare:192.0.2.10' }));
    remote.claim.mockReturnValueOnce({ ok: false, code: 'unknown_code' } as never);
    expect((await request('POST', '/api/remote/pair', { code: 'wrong' })).status).toBe(410);
    remote.claim.mockReturnValueOnce({ ok: false, code: 'rate_limited' } as never);
    expect((await request('POST', '/api/remote/pair', { code: 'wrong' })).status).toBe(429);
  });

  it('reports pairing status and redeems approval into a secure device cookie once', async () => {
    const { request, remote } = fixture();
    expect((await request('GET', '/api/remote/pair/status')).status).toBe(400);
    remote.pairingStatus.mockReturnValueOnce(undefined as never);
    expect((await request('GET', '/api/remote/pair/status?request=missing')).status).toBe(404);
    expect(await (await request('GET', '/api/remote/pair/status?request=one')).json()).toEqual({ status: 'pending' });
    remote.pairingStatus.mockReturnValueOnce('approved');
    const approved = await request('GET', '/api/remote/pair/status?request=one');
    expect(await approved.json()).toMatchObject({ status: 'approved', hostPublicKey: 'channel-key' });
    expect(approved.headers.get('set-cookie')).toContain('__Host-doompi_device=device-token');
    remote.pairingStatus.mockReturnValueOnce('approved');
    remote.redeem.mockReturnValueOnce(undefined as never);
    expect(await (await request('GET', '/api/remote/pair/status?request=one')).json()).toEqual({ status: 'consumed' });
  });

  it('keeps host control local and maps enable, pairing, and revoke outcomes', async () => {
    const { request, remote } = fixture();
    expect((await request('POST', '/api/remote/enable', undefined, 'tunnel')).status).toBe(403);
    remote.enable.mockReturnValueOnce(Promise.resolve({ ok: false, error: 'tunnel failed' }) as never);
    expect((await request('POST', '/api/remote/enable')).status).toBe(502);
    expect((await request('POST', '/api/remote/enable')).status).toBe(200);
    remote.handoverPending.mockReturnValueOnce(true);
    expect((await request('POST', '/api/remote/enable')).status).toBe(202);
    expect((await request('POST', '/api/remote/codes', undefined, 'tunnel')).status).toBe(403);
    remote.mintPairing.mockReturnValueOnce(undefined as never);
    expect((await request('POST', '/api/remote/codes')).status).toBe(409);
    expect((await request('POST', '/api/remote/codes')).status).toBe(201);
    remote.approve.mockReturnValueOnce('unknown');
    expect((await request('POST', '/api/remote/pairing/missing/approve')).status).toBe(404);
    remote.approve.mockReturnValueOnce('expired');
    expect((await request('POST', '/api/remote/pairing/old/approve')).status).toBe(409);
    expect((await request('POST', '/api/remote/pairing/one/approve')).status).toBe(200);
    remote.deny.mockReturnValueOnce('unknown');
    expect((await request('POST', '/api/remote/pairing/missing/deny')).status).toBe(404);
    remote.deny.mockReturnValueOnce('settled');
    expect((await request('POST', '/api/remote/pairing/old/deny')).status).toBe(409);
    expect((await request('POST', '/api/remote/pairing/one/deny')).status).toBe(200);
    remote.revokeDevice.mockReturnValueOnce(false);
    expect((await request('DELETE', '/api/remote/devices/missing')).status).toBe(404);
    expect((await request('DELETE', '/api/remote/devices/one')).status).toBe(200);
  });

  it('validates channel and settings requests', async () => {
    const { request, remote } = fixture();
    expect((await request('POST', '/api/remote/channel', { scope: 'session', clientPublicKey: 'key' })).status).toBe(
      401,
    );
    remote.authorize.mockReturnValue('device-1' as never);
    expect((await request('POST', '/api/remote/channel', { scope: 'invalid', clientPublicKey: 'key' })).status).toBe(
      400,
    );
    remote.openChannel.mockReturnValueOnce(false);
    expect((await request('POST', '/api/remote/channel', { scope: 'session', clientPublicKey: 'key' })).status).toBe(
      400,
    );
    expect((await request('POST', '/api/remote/channel', { scope: 'protocol', clientPublicKey: 'key' })).status).toBe(
      200,
    );
    expect((await request('PUT', '/api/remote/settings', { enabled: false }, 'tunnel')).status).toBe(403);
    expect((await request('PUT', '/api/remote/settings', 'bad')).status).toBe(400);
    expect((await request('PUT', '/api/remote/settings', [])).status).toBe(400);
    expect((await request('PUT', '/api/remote/settings', { enabled: false })).status).toBe(200);
    expect(remote.updateSettings).toHaveBeenCalledWith({ enabled: false });
  });

  it('routes passkey ceremony errors and success, with a browser-bound caller cookie', async () => {
    const { request, passkeys, remote } = fixture();
    expect((await request('POST', '/api/remote/passkeys/register/begin', undefined, 'tunnel')).status).toBe(401);
    expect((await request('POST', '/api/remote/passkeys/register/begin')).status).toBe(200);
    expect((await request('POST', '/api/remote/passkeys/register/finish', {})).status).toBe(400);
    passkeys.finishRegistration.mockReturnValueOnce(Promise.resolve({ ok: false, error: 'bad signature' }) as never);
    expect(
      (await request('POST', '/api/remote/passkeys/register/finish', { ceremonyId: 'reg-1', response: {} })).status,
    ).toBe(400);
    expect(
      (await request('POST', '/api/remote/passkeys/register/finish', { ceremonyId: 'reg-1', response: {} })).status,
    ).toBe(200);
    const begin = await request('POST', '/api/remote/passkeys/authenticate/begin', {}, 'tunnel');
    expect(begin.status).toBe(200);
    const cookie = begin.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toContain('__Host-doompi_ceremony_caller=');
    expect((await request('POST', '/api/remote/passkeys/authenticate/finish', {})).status).toBe(400);
    expect(
      (await request('POST', '/api/remote/passkeys/authenticate/finish', { ceremonyId: 'auth-1', response: {} }))
        .status,
    ).toBe(401);
    passkeys.finishAuthentication.mockReturnValueOnce(Promise.resolve({ ok: false, error: 'invalid' }) as never);
    expect(
      (
        await request(
          'POST',
          '/api/remote/passkeys/authenticate/finish',
          { ceremonyId: 'auth-1', response: {} },
          'tunnel',
          { cookie: cookie! },
        )
      ).status,
    ).toBe(401);
    remote.channelPublicKey.mockReturnValueOnce(undefined as never);
    expect(
      (
        await request(
          'POST',
          '/api/remote/passkeys/authenticate/finish',
          { ceremonyId: 'auth-1', response: {} },
          'tunnel',
          { cookie: cookie! },
        )
      ).status,
    ).toBe(409);
    const finish = await request(
      'POST',
      '/api/remote/passkeys/authenticate/finish',
      { ceremonyId: 'auth-1', response: {} },
      'tunnel',
      { cookie: cookie! },
    );
    expect(finish.status).toBe(200);
    expect(finish.headers.get('set-cookie')).toContain('__Host-doompi_device=passkey-token');
  });

  it('lists passkeys, validates step-up actions, and restricts passkey deletion', async () => {
    const { request, passkeys } = fixture();
    expect(await (await request('GET', '/api/remote/passkeys')).json()).toMatchObject({
      credentials: [{ id: 'key-1', label: 'Phone', createdAt: '1970-01-01T00:00:01.000Z' }],
    });
    expect((await request('POST', '/api/remote/challenge', {})).status).toBe(400);
    passkeys.beginStepUp.mockReturnValueOnce(Promise.resolve(undefined) as never);
    expect((await request('POST', '/api/remote/challenge', { action: 'session.create' })).status).toBe(409);
    expect((await request('POST', '/api/remote/challenge', { action: 'session.create' })).status).toBe(200);
    expect((await request('DELETE', '/api/remote/passkeys/key-1', undefined, 'tunnel')).status).toBe(403);
    passkeys.forget.mockReturnValueOnce(false);
    expect((await request('DELETE', '/api/remote/passkeys/missing')).status).toBe(404);
    expect((await request('DELETE', '/api/remote/passkeys/key-1')).status).toBe(200);
  });
});
