import { webcrypto } from 'node:crypto';

import type { BundleManifest } from '@agimon-ai/doompi-web-security/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActiveBundleState, VerifiedPluginCompositionState } from '../../src/pwa/bundleCache';

const mocks = vi.hoisted(() => ({
  active: undefined as ActiveBundleState | undefined,
  plugin: undefined as VerifiedPluginCompositionState | undefined,
  manifest: undefined as BundleManifest | undefined,
  verifyBundleAsset: vi.fn(),
  commitActiveBundle: vi.fn(),
  clearActiveBundle: vi.fn(),
  commitVerifiedPluginComposition: vi.fn(),
  clearVerifiedPluginComposition: vi.fn(),
}));
vi.mock('@agimon-ai/doompi-web-security/browser', () => ({
  BUNDLE_MANIFEST_ROUTE: '/api/bundle-manifest',
  canonicalManifest: (manifest: BundleManifest) => JSON.stringify(manifest),
  verifyBundleAsset: mocks.verifyBundleAsset,
  verifySignedBundleManifest: vi.fn(async () =>
    mocks.manifest === undefined
      ? { ok: false, failure: { code: 'bad-signature' } }
      : { ok: true, manifest: mocks.manifest },
  ),
}));

vi.mock('../../src/pwa/bundleCache', () => ({
  readActiveBundle: vi.fn(async () => mocks.active),
  commitActiveBundle: mocks.commitActiveBundle,
  clearActiveBundle: mocks.clearActiveBundle,
  readVerifiedPluginComposition: vi.fn(async () => mocks.plugin),
  listVerifiedPluginCompositions: vi.fn(async () => (mocks.plugin === undefined ? [] : [mocks.plugin])),
  commitVerifiedPluginComposition: mocks.commitVerifiedPluginComposition,
  clearVerifiedPluginComposition: mocks.clearVerifiedPluginComposition,
}));

type WorkerListener = (event: never) => void;
type FetchOutcome = { response?: Promise<Response>; lifetime?: Promise<unknown> };

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(cacheKey(key))?.clone();
  }

  async put(key: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(cacheKey(key), response.clone());
  }

  async delete(key: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(cacheKey(key));
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  failKeys = false;

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (cache === undefined) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async keys(): Promise<string[]> {
    if (this.failKeys) throw new Error('cache enumeration failed');
    return [...this.stores.keys()];
  }
}

const listeners = new Map<string, WorkerListener>();
let cacheStorage: MemoryCacheStorage;
let expectedBytes: Map<string, string>;
let rawFetches: string[];
let fetchImplementation: (input: RequestInfo | URL) => Promise<Response>;

function cacheKey(value: RequestInfo | URL): string {
  if (typeof value === 'string') return value;
  const url = value instanceof URL ? value : new URL(value.url);
  return url.origin === 'https://cockpit.test' ? url.pathname : url.href;
}

function asset(path: string, body: string) {
  return {
    path,
    sha256: 'a'.repeat(64),
    byteLength: new TextEncoder().encode(body).byteLength,
    contentType: path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : 'text/javascript',
  };
}

function manifest(revision: number, bodies: Record<string, string>): BundleManifest {
  expectedBytes = new Map(Object.entries(bodies));
  return {
    version: 2,
    revision,
    builtAt: revision,
    assets: Object.entries(bodies).map(([path, body]) => asset(path, body)),
  };
}

function networkResponse(
  path: string,
  body: string,
  options: { ok?: boolean; redirected?: boolean; url?: string } = {},
) {
  const response = new Response(body, { status: options.ok === false ? 500 : 200 });
  Object.defineProperties(response, {
    url: { value: options.url ?? `https://cockpit.test${path}` },
    redirected: { value: options.redirected ?? false },
  });
  return response;
}

async function activate(publicKey = 'key', minimumRevision = 1) {
  return await sendMessage({ type: 'doompi:activate-bundle', publicKey, minimumRevision });
}

async function reset() {
  return await sendMessage({ type: 'doompi:reset-bundle-trust' });
}

async function activatePlugin(compositionId: string, revision = 1) {
  const route = `/api/web-plugins/${compositionId}/${String(revision)}`;
  return await sendMessage({
    type: 'doompi:activate-plugin-composition',
    compositionId,
    revision,
    manifestUrl: `${route}/manifest`,
    rawAssetBaseUrl: `${route}/assets`,
    verifiedAssetBaseUrl: `/verified-plugins/${compositionId}/${String(revision)}`,
    relayThroughClient: false,
  });
}

async function sendMessage(data: unknown): Promise<Record<string, unknown>> {
  let lifetime: Promise<unknown> | undefined;
  let reply: Record<string, unknown> | undefined;
  const event = {
    data,
    ports: [{ postMessage: (value: Record<string, unknown>) => (reply = value) }],
    waitUntil: (value: Promise<unknown>) => (lifetime = value),
  };
  listeners.get('message')?.(event as never);
  await lifetime;
  if (reply === undefined) throw new Error('The service worker did not reply.');
  return reply;
}

function dispatchFetch(path: string): FetchOutcome {
  let response: Promise<Response> | undefined;
  let lifetime: Promise<unknown> | undefined;
  const event = {
    request: new Request(`https://cockpit.test${path}`),
    respondWith: (value: Promise<Response>) => (response = value),
    waitUntil: (value: Promise<unknown>) => (lifetime = value),
  };
  listeners.get('fetch')?.(event as never);
  return { response, lifetime };
}

async function body(response: Promise<Response> | undefined): Promise<string> {
  if (response === undefined) throw new Error('The service worker did not handle the fetch.');
  return await (await response).text();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  listeners.clear();
  cacheStorage = new MemoryCacheStorage();
  expectedBytes = new Map();
  rawFetches = [];
  mocks.active = undefined;
  mocks.plugin = undefined;
  mocks.manifest = undefined;
  mocks.commitActiveBundle.mockReset().mockImplementation(async (state: ActiveBundleState) => {
    mocks.active = state;
  });
  mocks.clearActiveBundle.mockReset().mockImplementation(async () => {
    mocks.active = undefined;
  });
  mocks.commitVerifiedPluginComposition
    .mockReset()
    .mockImplementation(async (state: VerifiedPluginCompositionState) => {
      mocks.plugin = state;
    });
  mocks.clearVerifiedPluginComposition.mockReset().mockImplementation(async () => {
    mocks.plugin = undefined;
  });
  mocks.verifyBundleAsset
    .mockReset()
    .mockImplementation(async (_manifest: BundleManifest, path: string, bytes: ArrayBuffer) => ({
      ok: new TextDecoder().decode(bytes) === expectedBytes.get(path),
      failure: { code: 'digest-mismatch' },
    }));
  fetchImplementation = async (input) => {
    const path = cacheKey(input);
    if (path === '/api/bundle-manifest') return networkResponse(path, '{}');
    rawFetches.push(path);
    return networkResponse(path, expectedBytes.get(path.replace(/^\/bundle-assets\/\d+/u, '')) ?? '');
  };
  Object.defineProperties(globalThis, {
    crypto: { configurable: true, value: webcrypto },
    caches: { configurable: true, value: cacheStorage },
    fetch: { configurable: true, value: vi.fn((input: RequestInfo | URL) => fetchImplementation(input)) },
    self: {
      configurable: true,
      value: {
        location: { origin: 'https://cockpit.test' },
        clients: { claim: vi.fn(), matchAll: vi.fn(async () => []) },
        registration: { showNotification: vi.fn() },
        skipWaiting: vi.fn(),
        setTimeout,
        clearTimeout,
        addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener),
      },
    },
  });
  await import('../../src/pwa/serviceWorker');
});

describe('verified bundle activation', () => {
  it('reuses verified bytes and limits raw required downloads to four at a time', async () => {
    const bodies = Object.fromEntries([
      ['/index.html', 'index'],
      ...Array.from({ length: 7 }, (_, index) => [`/assets/${String(index)}.js`, `asset-${String(index)}`]),
    ]);
    mocks.manifest = manifest(2, bodies);
    const oldCache = await cacheStorage.open('doompi-bundle-old');
    await oldCache.put('/index.html', new Response('index'));
    mocks.active = {
      signerPublicKey: 'key',
      manifestDigest: 'old',
      revision: 1,
      cacheName: 'doompi-bundle-old',
    };
    let active = 0;
    let maximum = 0;
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      if (path === '/api/bundle-manifest') return networkResponse(path, '{}');
      rawFetches.push(path);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const assetPath = path.replace('/bundle-assets/2', '');
      return networkResponse(path, expectedBytes.get(assetPath) ?? '');
    };

    await expect(activate()).resolves.toMatchObject({ ok: true, revision: 2 });
    expect(maximum).toBe(4);
    expect(rawFetches).not.toContain('/bundle-assets/2/index.html');
    expect(rawFetches).toHaveLength(7);
  });

  it('deletes failed staging without replacing the active bundle', async () => {
    mocks.manifest = manifest(2, { '/index.html': 'index', '/assets/app.js': 'good' });
    const previous: ActiveBundleState = {
      signerPublicKey: 'key',
      manifestDigest: 'old',
      revision: 1,
      cacheName: 'doompi-bundle-old',
    };
    mocks.active = previous;
    await cacheStorage.open(previous.cacheName);
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      return networkResponse(
        path,
        path.endsWith('app.js') ? 'corrupt' : path === '/api/bundle-manifest' ? '{}' : 'index',
      );
    };

    await expect(activate()).resolves.toMatchObject({ ok: false, code: 'asset-verification' });
    expect(mocks.active).toBe(previous);
    expect([...cacheStorage.stores.keys()].filter((name) => name !== previous.cacheName)).toEqual([]);
  });

  it('keeps a committed update when post-commit cleanup fails', async () => {
    mocks.manifest = manifest(2, { '/index.html': 'index' });
    cacheStorage.failKeys = true;

    await expect(activate()).resolves.toMatchObject({ ok: true, revision: 2 });
    expect(mocks.active?.revision).toBe(2);
  });

  it('waits for sibling downloads before deleting failed staging', async () => {
    mocks.manifest = manifest(1, {
      '/index.html': 'index',
      '/assets/a.js': 'a',
      '/assets/b.js': 'b',
      '/assets/c.js': 'c',
    });
    const release = deferred<void>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      if (path === '/api/bundle-manifest') return networkResponse(path, '{}');
      if (path.endsWith('/index.html')) return networkResponse(path, 'corrupt');
      await release.promise;
      return networkResponse(path, expectedBytes.get(path.replace('/bundle-assets/1', '')) ?? '');
    };
    const activation = activate();
    const earlyOutcome = await Promise.race([
      activation.then(() => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 5)),
    ]);
    release.resolve();
    await activation;

    expect(earlyOutcome).toBe('pending');
    expect(cacheStorage.stores.size).toBe(0);
  });

  it('stores the signed manifest envelope needed to authenticate later cache reads', async () => {
    mocks.manifest = manifest(1, { '/index.html': 'index' });

    await expect(activate()).resolves.toMatchObject({ ok: true });
    expect(mocks.active).toMatchObject({ signedManifest: {} });
  });

  it('retains the active cache for a valid same-revision activation', async () => {
    mocks.manifest = manifest(1, { '/index.html': 'index' });
    await activate();
    const cacheName = mocks.active?.cacheName;

    await expect(activate()).resolves.toMatchObject({ ok: true, revision: 1 });
    expect(mocks.active?.cacheName).toBe(cacheName);
  });

  it('falls back to eager delivery when the authenticated optional policy is invalid', async () => {
    mocks.manifest = manifest(1, {
      '/index.html': 'index',
      '/bundle-asset-policy.json': '{"version":1,"optional":["/assets/lazy.js","/assets/lazy.js"]}',
      '/assets/lazy.js': 'lazy',
    });

    await expect(activate()).resolves.toMatchObject({ ok: true });
    expect(rawFetches).toContain('/bundle-assets/1/assets/lazy.js');
    expect(mocks.active?.optionalAssetPaths).toEqual([]);
  });
});

describe('lazy verified delivery', () => {
  async function activateLazy() {
    mocks.manifest = manifest(1, {
      '/index.html': 'index',
      '/bundle-asset-policy.json': '{"version":1,"optional":["/assets/lazy.js"]}',
      '/assets/lazy.js': 'lazy',
    });
    await expect(activate()).resolves.toMatchObject({ ok: true });
    rawFetches = [];
  }

  it('fetches an exact optional miss once and deduplicates concurrent requests', async () => {
    await activateLazy();
    const gate = deferred<Response>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      rawFetches.push(path);
      return await gate.promise;
    };
    const first = dispatchFetch('/assets/lazy.js');
    const second = dispatchFetch('/assets/lazy.js');
    await vi.waitFor(() => expect(rawFetches).toEqual(['/bundle-assets/1/assets/lazy.js']));
    gate.resolve(networkResponse('/bundle-assets/1/assets/lazy.js', 'lazy'));

    await expect(Promise.all([body(first.response), body(second.response)])).resolves.toEqual(['lazy', 'lazy']);
    expect(await body(dispatchFetch('/assets/lazy.js').response)).toBe('lazy');
    expect(rawFetches).toHaveLength(1);
  });

  it('limits concurrent lazy downloads across distinct optional assets to four', async () => {
    const optional = Array.from({ length: 7 }, (_, index) => `/assets/lazy-${String(index)}.js`);
    mocks.manifest = manifest(1, {
      '/index.html': 'index',
      '/bundle-asset-policy.json': JSON.stringify({ version: 1, optional }),
      ...Object.fromEntries(optional.map((path) => [path, path])),
    });
    await activate();
    let active = 0;
    let maximum = 0;
    const release = deferred<void>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      active += 1;
      maximum = Math.max(maximum, active);
      await release.promise;
      active -= 1;
      const assetPath = path.replace('/bundle-assets/1', '');
      return networkResponse(path, expectedBytes.get(assetPath) ?? '');
    };
    const requests = optional.map((path) => {
      const response = dispatchFetch(path).response;
      if (response === undefined) throw new Error('The service worker did not handle the optional asset.');
      return response;
    });
    await vi.waitFor(() => expect(active).toBeGreaterThan(0));
    const observedMaximum = maximum;
    release.resolve();
    await Promise.all(requests);

    expect(observedMaximum).toBe(4);
    expect(maximum).toBe(4);
  });

  it.each([
    ['unlisted bytes', '/assets/unlisted.js', 'injected'],
    ['corrupt listed bytes', '/index.html', 'corrupt'],
  ])('refuses cached %s', async (_name, path, cachedBody) => {
    await activateLazy();
    const cache = await cacheStorage.open(mocks.active?.cacheName ?? '');
    await cache.put(path, new Response(cachedBody));

    expect((await dispatchFetch(path).response)?.status).toBe(404);
  });

  it('returns 404 without network access for unlisted and legacy cache misses', async () => {
    await activateLazy();
    expect((await dispatchFetch('/assets/unlisted.js').response)?.status).toBe(404);
    expect(rawFetches).toEqual([]);

    mocks.active = { signerPublicKey: 'key', manifestDigest: 'legacy', revision: 1, cacheName: 'legacy' };
    const legacy = await cacheStorage.open('legacy');
    await legacy.put('/index.html', new Response('legacy index'));
    expect(await body(dispatchFetch('/index.html').response)).toBe('legacy index');
    expect((await dispatchFetch('/assets/lazy.js').response)?.status).toBe(404);
    expect(rawFetches).toEqual([]);
  });

  it.each([
    ['corrupt bytes', { body: 'corrupt' }],
    ['a redirect', { body: 'lazy', redirected: true }],
    ['an untrusted path', { body: 'lazy', url: 'https://cockpit.test/wrong' }],
  ])('rejects %s and does not cache it', async (_name, responseOptions) => {
    await activateLazy();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      if (path === '/api/bundle-manifest') return networkResponse(path, '{}');
      const { body: responseBody, ...options } = responseOptions;
      return networkResponse(path, responseBody, options);
    };

    expect((await dispatchFetch('/assets/lazy.js').response)?.status).toBe(404);
    expect(await (await cacheStorage.open(mocks.active?.cacheName ?? '')).match('/assets/lazy.js')).toBeUndefined();
  });

  it('does not cache an optional download into a newer active revision', async () => {
    await activateLazy();
    const oldDownload = deferred<Response>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      if (path === '/bundle-assets/1/assets/lazy.js') return await oldDownload.promise;
      if (path === '/api/bundle-manifest') return networkResponse(path, '{}');
      const assetPath = path.replace('/bundle-assets/2', '');
      return networkResponse(path, expectedBytes.get(assetPath) ?? '');
    };
    const pendingFetch = dispatchFetch('/assets/lazy.js');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    mocks.manifest = manifest(2, {
      '/index.html': 'index 2',
      '/bundle-asset-policy.json': '{"version":1,"optional":["/assets/lazy.js"]}',
      '/assets/lazy.js': 'lazy',
    });

    await expect(sendMessage({ type: 'doompi:refresh-bundle' })).resolves.toMatchObject({ ok: true, revision: 2 });
    oldDownload.resolve(networkResponse('/bundle-assets/1/assets/lazy.js', 'lazy'));

    expect((await pendingFetch.response)?.status).toBe(404);
    expect(mocks.active?.revision).toBe(2);
    expect(await (await cacheStorage.open(mocks.active?.cacheName ?? '')).match('/assets/lazy.js')).toBeUndefined();
  });

  it('discards an optional download when reset overtakes it', async () => {
    await activateLazy();
    const gate = deferred<Response>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      if (path === '/api/bundle-manifest') return networkResponse(path, '{}');
      if (path === '/bundle-assets/1/assets/lazy.js') return await gate.promise;
      const assetPath = path.replace('/bundle-assets/1', '');
      return networkResponse(path, expectedBytes.get(assetPath) ?? '');
    };
    const pendingFetch = dispatchFetch('/assets/lazy.js');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await expect(reset()).resolves.toEqual({ ok: true });
    gate.resolve(networkResponse('/bundle-assets/1/assets/lazy.js', 'lazy'));

    expect((await pendingFetch.response)?.status).toBe(404);
    expect(mocks.active).toBeUndefined();
  });

  it('clears durable trust even when cache cleanup fails', async () => {
    mocks.active = {
      signerPublicKey: 'key',
      manifestDigest: 'old',
      revision: 1,
      cacheName: 'doompi-bundle-old',
    };
    cacheStorage.failKeys = true;

    await expect(reset()).resolves.toEqual({ ok: true });
    expect(mocks.clearActiveBundle).toHaveBeenCalledOnce();
    expect(mocks.active).toBeUndefined();
  });

  it('clears durable host trust even when plugin cleanup fails', async () => {
    mocks.active = {
      signerPublicKey: 'key',
      manifestDigest: 'host',
      revision: 1,
      cacheName: 'doompi-bundle-host',
    };
    mocks.plugin = {
      compositionId: 'a'.repeat(64),
      signerPublicKey: 'key',
      manifestDigest: 'plugin',
      revision: 1,
      cacheName: 'doompi-plugin-old',
      verifiedAssetBaseUrl: `/verified-plugins/${'a'.repeat(64)}/1`,
      lastUsedAt: 1,
    };
    const assetPath = `${mocks.plugin.verifiedAssetBaseUrl}/plugin.js`;
    await (await cacheStorage.open(mocks.plugin.cacheName)).put(assetPath, new Response('old plugin'));
    mocks.clearVerifiedPluginComposition.mockRejectedValueOnce(new Error('plugin cleanup failed'));
    cacheStorage.failKeys = true;

    await expect(reset()).resolves.toEqual({ ok: true });
    expect(mocks.clearActiveBundle).toHaveBeenCalledOnce();
    expect(mocks.active).toBeUndefined();
    expect((await dispatchFetch(assetPath).response)?.status).toBe(404);
  });

  it('does not commit an activation that a reset overtakes', async () => {
    mocks.manifest = manifest(1, { '/index.html': 'index' });
    const gate = deferred<Response>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      return path === '/api/bundle-manifest' ? networkResponse(path, '{}') : await gate.promise;
    };
    const pendingActivation = activate();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const pendingReset = reset();
    gate.resolve(networkResponse('/bundle-assets/1/index.html', 'index'));

    await expect(pendingActivation).resolves.toMatchObject({ ok: false, code: 'asset-verification' });
    await expect(pendingReset).resolves.toEqual({ ok: true });
    expect(mocks.active).toBeUndefined();
  });

  it('does not commit or report success for a plugin activation overtaken by reset', async () => {
    const compositionId = 'a'.repeat(64);
    mocks.active = {
      signerPublicKey: 'key',
      manifestDigest: 'host',
      revision: 1,
      cacheName: 'doompi-bundle-host',
    };
    mocks.manifest = manifest(1, { '/plugin.js': 'plugin' });
    const gate = deferred<Response>();
    fetchImplementation = async (input) => {
      const path = cacheKey(input);
      if (path.endsWith('/manifest')) return networkResponse(path, '{}');
      return await gate.promise;
    };
    const pendingActivation = activatePlugin(compositionId);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const pendingReset = reset();
    gate.resolve(networkResponse(`/api/web-plugins/${compositionId}/1/assets/plugin.js`, 'plugin'));

    await expect(pendingActivation).resolves.toMatchObject({ ok: false, code: 'trust-reset' });
    await expect(pendingReset).resolves.toEqual({ ok: true });
    expect(mocks.commitVerifiedPluginComposition).not.toHaveBeenCalled();
    expect(mocks.plugin).toBeUndefined();
  });
});
