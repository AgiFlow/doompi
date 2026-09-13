import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => typeof globalThis.PublicKeyCredential !== 'undefined',
  startAuthentication: vi.fn(async () => ({ id: 'authenticated' })),
  startRegistration: vi.fn(async () => ({ id: 'registered' })),
}));
import {
  assertionFor,
  passkeysAvailable,
  registerPasskey,
  signInWithPasskey,
} from '../../src/web/lib/webauthnClient.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
  Reflect.deleteProperty(globalThis, 'window');
});

describe('without passkey support', () => {
  it('says so rather than failing mid-ceremony', async () => {
    // Node has no WebAuthn, which is the same shape as a browser that lacks it.
    expect(passkeysAvailable()).toBe(false);
    await expect(registerPasskey()).resolves.toEqual({
      ok: false,
      error: 'This browser has no passkey support.',
    });
    await expect(signInWithPasskey()).resolves.toEqual({
      ok: false,
      error: 'This browser has no passkey support.',
    });
  });

  it('produces no assertion, so a gated action simply does not proceed', async () => {
    await expect(assertionFor('session.create')).resolves.toBeUndefined();
  });
});

describe('when the hub will not start a ceremony', () => {
  it('reports the tunnel cannot carry a passkey', async () => {
    // Stubbing only the capability check: the ceremony itself needs a real
    // authenticator, and the branch worth pinning is the refusal before it.
    Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true });
    globalThis.fetch = vi.fn(async () => new Response('{"error":"no"}', { status: 409 })) as unknown as typeof fetch;

    const registered = await registerPasskey();
    expect(registered.ok).toBe(false);
    if (registered.ok) return;
    expect(registered.error).toContain('unavailable');

    const signedIn = await signInWithPasskey();
    expect(signedIn.ok).toBe(false);
    if (signedIn.ok) return;
    expect(signedIn.error).toContain('unavailable');
  });

  it('produces no assertion when the challenge is refused', async () => {
    Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true });
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;
    await expect(assertionFor('provider.login')).resolves.toBeUndefined();
  });

  it('produces no assertion when the hub is unreachable', async () => {
    Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true });
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(assertionFor('provider.logout')).resolves.toBeUndefined();
  });
});

describe('isolated ceremonies', () => {
  it.each([
    [registerPasskey, '/passkeys/register/begin', '/passkeys/register/finish', 'registered'],
    [signInWithPasskey, '/passkeys/authenticate/begin', '/passkeys/authenticate/finish', 'authenticated'],
  ] as const)(
    'returns the ceremony ID with the response for %s',
    async (run, beginRoute, finishRoute, credentialId) => {
      Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true });
      const remember = vi.fn();
      Object.defineProperty(globalThis, 'window', {
        value: { sessionStorage: { setItem: remember } },
        configurable: true,
      });
      const calls: Array<{ url: string; body: string | undefined }> = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        const url = String(input);
        calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
        if (url.endsWith(beginRoute)) {
          return new Response(JSON.stringify({ ceremonyId: 'ceremony-1', options: { challenge: 'challenge' } }));
        }
        const result = run === signInWithPasskey ? { hostPublicKey: 'host-key' } : {};
        return new Response(JSON.stringify(result));
      }) as unknown as typeof fetch;

      await expect(run()).resolves.toEqual({ ok: true });
      const finish = calls.find((call) => call.url.endsWith(finishRoute));
      expect(finish).toBeDefined();
      expect(JSON.parse(finish?.body ?? '{}')).toEqual({
        ceremonyId: 'ceremony-1',
        response: { id: credentialId },
      });
      if (run === signInWithPasskey) expect(remember).toHaveBeenCalledWith('doompi.channelKey', 'host-key');
    },
  );

  it('carries the ceremony ID in a step-up assertion', async () => {
    Object.defineProperty(globalThis, 'PublicKeyCredential', { value: class {}, configurable: true });
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ceremonyId: 'step-up-1', options: { challenge: 'challenge' } })),
    ) as unknown as typeof fetch;

    const encoded = await assertionFor('session.create');
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8'))).toEqual({
      ceremonyId: 'step-up-1',
      response: { id: 'authenticated' },
    });
  });
});
