import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Page } from '@playwright/test';

import { expect, test as cockpitTest } from '../support/cockpit';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const test = cockpitTest.extend<{ assetPackageRoot: string }>({
  assetPackageRoot: async ({ assets }, use) => {
    if (assets !== 'packaged') throw new Error('PWA mutation tests require an isolated packaged bundle.');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-pwa-assets-'));
    fs.cpSync(path.join(packageRoot, 'dist'), path.join(root, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(root, 'package.json'));
    fs.symlinkSync(
      path.join(packageRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      await use(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
});
test.setTimeout(60_000);

interface BundleAsset {
  path: string;
  sha256: string;
}

interface BundleManifest {
  revision: number;
  assets: BundleAsset[];
}

interface BundleSnapshot {
  cacheName: string;
  cachedPaths: string[];
  manifest: BundleManifest;
  optionalPaths: string[];
}

async function bundleSnapshot(page: Page): Promise<BundleSnapshot> {
  return await page.evaluate(async () => {
    const envelope = (await (await fetch('/bundle-manifest.json', { cache: 'no-store' })).json()) as {
      manifest: BundleManifest;
    };
    const policyResponse = await fetch(
      `/bundle-assets/${String(envelope.manifest.revision)}/bundle-asset-policy.json`,
      { cache: 'no-store' },
    );
    const policy = (await policyResponse.json()) as { optional: string[] };
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const databases = await indexedDB.databases();
      if (databases.some((database) => database.name === 'doompi-pwa')) {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('doompi-pwa');
          request.addEventListener('success', () => resolve(request.result), { once: true });
          request.addEventListener(
            'error',
            () => reject(request.error ?? new Error('The PWA database could not be opened.')),
            { once: true },
          );
        });
        const active = await (async () => {
          if (!database.objectStoreNames.contains('state')) return undefined;
          const transaction = database.transaction('state', 'readonly');
          return await new Promise<{ cacheName?: unknown } | undefined>((resolve, reject) => {
            const request = transaction.objectStore('state').get('active-bundle');
            request.addEventListener('success', () => resolve(request.result as { cacheName?: unknown } | undefined), {
              once: true,
            });
            request.addEventListener(
              'error',
              () => reject(request.error ?? new Error('The active bundle could not be read.')),
              { once: true },
            );
          });
        })();
        database.close();
        const cacheNames = (await caches.keys()).filter((name) =>
          name.startsWith(`doompi-bundle-${String(envelope.manifest.revision)}-`),
        );
        if (typeof active?.cacheName === 'string' && cacheNames.includes(active.cacheName)) {
          const cacheName = active.cacheName;
          const cachedPaths = (await (await caches.open(cacheName)).keys()).map(
            (request) => new URL(request.url).pathname,
          );
          return { cacheName, cachedPaths, manifest: envelope.manifest, optionalPaths: policy.optional };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The active verified bundle cache is unavailable.');
  });
}

async function fetchDigest(page: Page, path: string): Promise<{ digest: string; status: number }> {
  return await page.evaluate(async (assetPath) => {
    const response = await fetch(assetPath, { cache: 'no-store' });
    const bytes = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return { digest, status: response.status };
  }, path);
}

async function bundleCacheName(page: Page, revision: number): Promise<string | undefined> {
  return await page.evaluate(async (activeRevision) => {
    return (await caches.keys()).find((name) => name.startsWith(`doompi-bundle-${String(activeRevision)}-`));
  }, revision);
}

function publishChangedWebTree(assetPackageRoot: string): void {
  const distRoot = path.join(assetPackageRoot, 'dist');
  const webRoot = path.join(distRoot, 'web');
  const nextRoot = path.join(distRoot, 'web-next');
  const previousRoot = path.join(distRoot, 'web-previous');
  fs.cpSync(webRoot, nextRoot, { recursive: true });
  fs.appendFileSync(path.join(nextRoot, 'index.html'), '\n<!-- e2e republished bundle -->\n');
  fs.renameSync(webRoot, previousRoot);
  try {
    fs.renameSync(nextRoot, webRoot);
  } catch (error) {
    fs.renameSync(previousRoot, webRoot);
    throw error;
  }
  fs.rmSync(previousRoot, { recursive: true, force: true });
}
test('activates the verified production core without eagerly caching deferred assets', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);

  const snapshot = await bundleSnapshot(page);
  const controlled = await page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js') ?? false,
  );
  const optional = new Set(snapshot.optionalPaths);
  const corePaths = snapshot.manifest.assets.map((asset) => asset.path).filter((path) => !optional.has(path));

  expect(controlled).toBe(true);
  expect(snapshot.cacheName).toContain(`doompi-bundle-${String(snapshot.manifest.revision)}-`);
  expect(
    snapshot.optionalPaths.length,
    'the production bundle must expose at least one deferred asset',
  ).toBeGreaterThan(0);
  expect(snapshot.cachedPaths).toEqual(expect.arrayContaining(corePaths));
  expect(snapshot.cachedPaths.filter((path) => optional.has(path))).toEqual([]);
});

test('verifies a deferred asset on demand and serves the populated cache offline', async ({
  page,
  context,
  cockpit,
}) => {
  await page.goto(cockpit.url);

  const before = await bundleSnapshot(page);
  const assetPath = before.optionalPaths[0];
  if (assetPath === undefined) throw new Error('The production bundle does not contain a deferred asset.');
  const asset = before.manifest.assets.find((candidate) => candidate.path === assetPath);
  if (asset === undefined) throw new Error(`The deferred asset ${assetPath} is absent from the signed manifest.`);
  expect(before.cachedPaths).not.toContain(assetPath);

  const online = await fetchDigest(page, assetPath);
  expect(online).toEqual({ status: 200, digest: asset.sha256 });
  const populated = await bundleSnapshot(page);
  expect(populated.cacheName).toBe(before.cacheName);
  expect(populated.cachedPaths).toContain(assetPath);

  await context.setOffline(true);
  const offline = await fetchDigest(page, assetPath);
  expect(offline).toEqual(online);
});

test('rejects corrupt cached optional bytes and cache entries absent from the signed manifest', async ({
  page,
  context,
  cockpit,
}) => {
  await page.goto(cockpit.url);

  const snapshot = await bundleSnapshot(page);
  const optionalPath = snapshot.optionalPaths[0];
  if (optionalPath === undefined) throw new Error('The production bundle does not contain a deferred asset.');
  const unlistedPath = '/assets/not-in-signed-manifest.js';
  await page.evaluate(
    async ({ cacheName, corruptPath, injectedPath }) => {
      const cache = await caches.open(cacheName);
      await cache.put(corruptPath, new Response('corrupt'));
      await cache.put(injectedPath, new Response('injected'));
    },
    { cacheName: snapshot.cacheName, corruptPath: optionalPath, injectedPath: unlistedPath },
  );

  await context.setOffline(true);
  expect(await page.evaluate(async (assetPath) => (await fetch(assetPath)).status, optionalPath)).toBe(404);
  expect(await page.evaluate(async (assetPath) => (await fetch(assetPath)).status, unlistedPath)).toBe(404);
});

test('reloads the verified core shell offline', async ({ page, context, cockpit }) => {
  await page.goto(cockpit.url);
  const before = await bundleSnapshot(page);

  await context.setOffline(true);
  const response = await page.reload({ waitUntil: 'domcontentloaded' });

  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('cockpit')).toBeVisible();
  expect(await bundleCacheName(page, before.manifest.revision)).toBe(before.cacheName);
});

test('notifies every controlled tab after a newer verified revision is committed', async ({
  page,
  context,
  cockpit,
  assetPackageRoot,
}) => {
  const updatedRevisionKey = 'doompi-e2e-bundle-updated';
  const captureRevision = (storageKey: string): void => {
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: unknown; revision?: unknown };
      if (message?.type === 'doompi:bundle-updated' && Number.isSafeInteger(message.revision)) {
        sessionStorage.setItem(storageKey, String(message.revision));
      }
    });
  };
  await page.addInitScript(captureRevision, updatedRevisionKey);
  await page.goto(cockpit.url);
  await bundleSnapshot(page);
  await page.goto(`${cockpit.url}/api/health`);
  const secondPage = await context.newPage();
  await secondPage.addInitScript(captureRevision, updatedRevisionKey);
  await secondPage.goto(`${cockpit.url}/api/health`);
  await expect.poll(async () => await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect
    .poll(async () => await secondPage.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  const before = await bundleSnapshot(page);
  const retainedPath = before.optionalPaths[0];
  if (retainedPath === undefined) throw new Error('The production bundle does not contain a deferred asset.');
  const retainedAsset = before.manifest.assets.find((asset) => asset.path === retainedPath);
  if (retainedAsset === undefined)
    throw new Error(`The deferred asset ${retainedPath} is absent from the signed manifest.`);
  expect((await fetchDigest(page, retainedPath)).status).toBe(200);
  const downloads: Array<Promise<{ path: string; bodyBytes: number; headerBytes: number }>> = [];
  const recordDownload = (request: import('@playwright/test').Request): void => {
    const pathname = new URL(request.url()).pathname;
    if (request.serviceWorker() !== null && pathname.startsWith('/bundle-assets/')) {
      downloads.push(
        request.sizes().then((sizes) => ({
          path: pathname,
          bodyBytes: sizes.responseBodySize,
          headerBytes: sizes.responseHeadersSize,
        })),
      );
    }
  };
  context.on('requestfinished', recordDownload);
  publishChangedWebTree(assetPackageRoot);
  cockpit.republishShell();

  const refresh = () =>
    page.evaluate(async () => {
      const worker = (await navigator.serviceWorker.ready).active;
      if (worker === null) throw new Error('The trusted service worker is unavailable.');
      const channel = new MessageChannel();
      return await new Promise<unknown>((resolve) => {
        channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => resolve(event.data), {
          once: true,
        });
        channel.port1.start();
        worker.postMessage({ type: 'doompi:refresh-bundle' }, [channel.port2]);
      });
    });
  const refreshed = await refresh();
  expect(refreshed).toMatchObject({ ok: true, revision: expect.any(Number) });
  const revision = (refreshed as { revision: number }).revision;
  expect(revision).toBeGreaterThan(before.manifest.revision);
  await expect
    .poll(async () => await page.evaluate((key) => sessionStorage.getItem(key), updatedRevisionKey))
    .toBe(String(revision));
  await expect
    .poll(async () => await secondPage.evaluate((key) => sessionStorage.getItem(key), updatedRevisionKey))
    .toBe(String(revision));

  const transferred = await Promise.all(downloads.splice(0));
  expect(transferred.map((request) => request.path)).toEqual([`/bundle-assets/${String(revision)}/index.html`]);
  expect(transferred[0]?.bodyBytes).toBeGreaterThan(0);
  console.log('Verified update transfer:', JSON.stringify(transferred));
  expect(await refresh()).toMatchObject({ ok: true, revision });
  context.off('requestfinished', recordDownload);
  expect(await Promise.all(downloads)).toEqual([]);

  const after = await bundleSnapshot(page);
  expect(after.manifest.revision).toBe(revision);
  expect(after.cacheName).not.toBe(before.cacheName);
  expect(after.cachedPaths).toContain(retainedPath);
  await context.setOffline(true);
  expect(await fetchDigest(page, retainedPath)).toEqual({ status: 200, digest: retainedAsset.sha256 });
});
