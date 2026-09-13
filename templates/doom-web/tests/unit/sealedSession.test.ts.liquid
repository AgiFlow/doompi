import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rememberHostChannelKey,
  rememberedHostChannelKey,
  resetSealedSessions,
  restoreSealedSession,
  sealedHttpSession,
  sealedProtocolSession,
  sealedSession,
} from '../../src/web/lib/sealedSession.ts';
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
  resetSealedSessions();
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

  it('completes all three purpose-bound exchanges and reports every channel live', async () => {
    const host = createHostHandshake();
    rememberHostChannelKey(host.publicKey);
    const registrations: Array<{ scope: string; clientPublicKey: string }> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      registrations.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as (typeof registrations)[number]);
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;

    await expect(restoreSealedSession()).resolves.toBe(true);
    expect(registrations.map(({ scope }) => scope)).toEqual(['session', 'protocol', 'http']);
    expect(new Set(registrations.map(({ clientPublicKey }) => clientPublicKey)).size).toBe(3);
    expect(sealedSession.active()).toBe(true);
    expect(sealedProtocolSession.active()).toBe(true);
    expect(sealedHttpSession.active()).toBe(true);
    for (const { clientPublicKey } of registrations) expect(host.accept(clientPublicKey)).toBeDefined();
  });

  it('seals Pi bytes and complete HTTP requests before they reach the relay', async () => {
    const host = createHostHandshake();
    rememberHostChannelKey(host.publicKey);
    const serverChannels = new Map<string, NonNullable<ReturnType<typeof host.accept>>>();
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const registration = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        scope: string;
        clientPublicKey: string;
      };
      const channel = host.accept(registration.clientPublicKey);
      if (channel === undefined) return new Response('{"error":"bad key"}', { status: 400 });
      serverChannels.set(registration.scope, channel);
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    await expect(restoreSealedSession()).resolves.toBe(true);

    const piPlaintext = new Uint8Array([0, 1, 2, 128, 255]);
    const piWire = await sealedProtocolSession.sealBinary(piPlaintext);
    expect(Array.from(piWire)).not.toEqual(Array.from(piPlaintext));
    const piOpened = serverChannels.get('protocol')?.open(JSON.parse(new TextDecoder().decode(piWire)));
    expect(piOpened?.ok && Array.from(piOpened.plaintext)).toEqual(Array.from(piPlaintext));

    const httpPlaintext = '{"v":1,"method":"POST","target":"/api/private","body":"c2VjcmV0"}';
    const httpWire = await sealedHttpSession.sealText(httpPlaintext);
    expect(httpWire).not.toContain('/api/private');
    expect(httpWire).not.toContain('c2VjcmV0');
    const httpOpened = serverChannels.get('http')?.open(JSON.parse(httpWire));
    expect(httpOpened?.ok && new TextDecoder().decode(httpOpened.plaintext)).toBe(httpPlaintext);
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
