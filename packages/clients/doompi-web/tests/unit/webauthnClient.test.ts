import { afterEach, describe, expect, it, vi } from 'vitest';
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
