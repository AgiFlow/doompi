import type { AuthEntry, TokenStore } from '@agimon-ai/mcp-proxy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYRING_SERVICE, type KeyringEntry, KeyringTokenStore } from '../src/adapters/node/keyringTokenStore.ts';

const entry: AuthEntry = {
  serverUrl: 'https://api.example.test/mcp',
  tokens: { access_token: 'at-1', token_type: 'Bearer' },
};

function memoryStore(): TokenStore & { entries: Map<string, AuthEntry> } {
  const entries = new Map<string, AuthEntry>();
  return {
    entries,
    read: (name) => Promise.resolve(entries.get(name)),
    write: (name, value) => {
      entries.set(name, value);
      return Promise.resolve();
    },
    clear: (name) => {
      entries.delete(name);
      return Promise.resolve();
    },
  };
}

interface FakeKeyring {
  factory: (service: string, account: string) => KeyringEntry;
  passwords: Map<string, string>;
  services: string[];
  accounts: string[];
  fail: (mode: 'read' | 'write' | 'delete' | 'none') => void;
}

function fakeKeyring(): FakeKeyring {
  const passwords = new Map<string, string>();
  const services: string[] = [];
  const accounts: string[] = [];
  let failing: 'read' | 'write' | 'delete' | 'none' = 'none';

  return {
    passwords,
    services,
    accounts,
    fail: (mode) => {
      failing = mode;
    },
    factory: (service, account) => {
      services.push(service);
      accounts.push(account);
      return {
        getPassword: () =>
          failing === 'read' ? Promise.reject(new Error('no secret service')) : Promise.resolve(passwords.get(account)),
        setPassword: (password) => {
          if (failing === 'write') return Promise.reject(new Error('keyring locked'));
          passwords.set(account, password);
          return Promise.resolve();
        },
        deletePassword: () => {
          if (failing === 'delete') return Promise.reject(new Error('keyring locked'));
          passwords.delete(account);
          return Promise.resolve(true);
        },
      };
    },
  };
}

let keyring: FakeKeyring;
let fallback: ReturnType<typeof memoryStore>;
let store: KeyringTokenStore;

beforeEach(() => {
  keyring = fakeKeyring();
  fallback = memoryStore();
  store = new KeyringTokenStore(keyring.factory, fallback);
});

describe('KeyringTokenStore', () => {
  it('round-trips a credential through the keyring', async () => {
    await store.write('api', entry);

    expect(await store.read('api')).toEqual(entry);
    expect(fallback.entries.size).toBe(0);
  });

  it('keys credentials by server name under one service', async () => {
    await store.write('api', entry);

    expect(keyring.services).toEqual([KEYRING_SERVICE]);
    expect(keyring.accounts).toEqual(['api']);
  });

  it('reports a server that was never authorized as unauthenticated', async () => {
    expect(await store.read('never-seen')).toBeUndefined();
  });

  it('treats an unparseable credential as absent so the next authorization replaces it', async () => {
    keyring.passwords.set('api', 'not json');

    expect(await store.read('api')).toBeUndefined();
  });

  it('removes the credential', async () => {
    await store.write('api', entry);

    await store.clear('api');

    expect(await store.read('api')).toBeUndefined();
  });

  describe('when the keyring is unusable', () => {
    it('serves reads from the fallback instead of failing', async () => {
      await fallback.write('api', entry);
      keyring.fail('read');

      expect(await store.read('api')).toEqual(entry);
      expect(store.isDegraded).toBe(true);
    });

    it('writes to the fallback instead of losing the credential', async () => {
      keyring.fail('write');

      await store.write('api', entry);

      expect(fallback.entries.get('api')).toEqual(entry);
    });

    // Probing the keyring on every call would stall each operation on a box whose
    // secret service is simply not there.
    it('stays on the fallback for the rest of the session', async () => {
      keyring.fail('write');
      await store.write('api', entry);
      keyring.fail('none');

      expect(await store.read('api')).toEqual(entry);
      expect(keyring.passwords.has('api')).toBe(false);
    });

    it('does not report a degraded store before anything has failed', () => {
      expect(store.isDegraded).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes a copy the fallback picked up while the keyring was down', async () => {
      keyring.fail('write');
      await store.write('api', entry);
      keyring.fail('none');

      await store.clear('api');

      expect(fallback.entries.has('api')).toBe(false);
    });

    // Reporting "cleared" while the credential survives in the keyring would leave the
    // user believing they had signed out.
    it('reports a keyring that refuses the delete, after clearing the fallback', async () => {
      await store.write('api', entry);
      await fallback.write('api', entry);
      keyring.fail('delete');

      await expect(store.clear('api')).rejects.toThrow('could not be removed');
      expect(fallback.entries.has('api')).toBe(false);
      expect(keyring.passwords.has('api')).toBe(true);
    });
  });
});

describe('createTokenStore', () => {
  it('falls back when the native keyring module cannot be loaded', async () => {
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('no prebuilt binary for this platform');
    });
    vi.resetModules();
    const { createTokenStore } = await import('../src/adapters/node/keyringTokenStore.ts');
    const configured = memoryStore();

    expect(await createTokenStore(configured)).toBe(configured);
    vi.doUnmock('@napi-rs/keyring');
  });
});
