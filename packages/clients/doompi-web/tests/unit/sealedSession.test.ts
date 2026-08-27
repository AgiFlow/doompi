import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rememberHostChannelKey,
  rememberedHostChannelKey,
  restoreSealedSession,
} from '../../src/web/lib/sealedSession.ts';
import { sealedSession } from '../../src/web/lib/sealedSession.ts';
import { createHostHandshake } from '@agimon-ai/doompi-web-security/node';

const originalFetch = globalThis.fetch;
const store = new Map<string, string>();

// The module reads window.sessionStorage, so that is what has to exist.
Object.defineProperty(globalThis, 'window', {
  value: {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  },
  configurable: true,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  store.clear();
  sealedSession.reset();
});

describe('the remembered host key', () => {
  it('round-trips through session storage', () => {
    expect(rememberedHostChannelKey()).toBeUndefined();
    rememberHostChannelKey('a-key');
    expect(rememberedHostChannelKey()).toBe('a-key');
  });
});

describe('restoreSealedSession', () => {
  it('does nothing on loopback, where no key was ever stored', async () => {
    await expect(restoreSealedSession()).resolves.toBe(false);
    expect(sealedSession.active()).toBe(false);
  });

  it('completes the exchange and reports the channel live', async () => {
    const host = createHostHandshake();
    rememberHostChannelKey(host.publicKey);
    let sentKey: string | undefined;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sentKey = (JSON.parse(typeof init?.body === 'string' ? init.body : '') as { clientPublicKey: string })
        .clientPublicKey;
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;

    await expect(restoreSealedSession()).resolves.toBe(true);
    expect(sealedSession.active()).toBe(true);
    expect(host.accept(sentKey ?? '')).toBeDefined();
  });

  it('falls back to plaintext when the host never completes its half', async () => {
    // Sealing against a host that did not accept would produce messages nobody
    // can open, which is a blackout rather than a security win.
    const host = createHostHandshake();
    rememberHostChannelKey(host.publicKey);
    globalThis.fetch = vi.fn(async () => new Response('{"error":"nope"}', { status: 401 })) as unknown as typeof fetch;

    await expect(restoreSealedSession()).resolves.toBe(false);
    expect(sealedSession.active()).toBe(false);
  });

  it('falls back when the hub is unreachable', async () => {
    const host = createHostHandshake();
    rememberHostChannelKey(host.publicKey);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(restoreSealedSession()).resolves.toBe(false);
    expect(sealedSession.active()).toBe(false);
  });

  it('reports failure for a stored key that is not a key', async () => {
    rememberHostChannelKey('not-a-key');
    await expect(restoreSealedSession()).resolves.toBe(false);
  });
});
