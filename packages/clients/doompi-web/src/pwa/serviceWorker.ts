/// <reference lib="webworker" />

import {
  BUNDLE_MANIFEST_ROUTE,
  canonicalManifest,
  verifyBundleAsset,
  verifySignedBundleManifest,
} from '@agimon-ai/doompi-web-security/browser';
import { BUNDLE_UPDATED_MESSAGE, type BundleUpdatedMessage } from '../types/bundle.ts';
import { clearActiveBundle, commitActiveBundle, readActiveBundle, type ActiveBundleState } from './bundleCache.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;
const RAW_BUNDLE_PREFIX = '/bundle-assets/';
const CACHE_PREFIX = 'doompi-bundle-';
const ACTIVATE_MESSAGE = 'doompi:activate-bundle';
const REFRESH_MESSAGE = 'doompi:refresh-bundle';
const RESET_MESSAGE = 'doompi:reset-bundle-trust';

interface ActivateBundleMessage {
  type: typeof ACTIVATE_MESSAGE;
  publicKey: string;
  minimumRevision: number;
}

interface RefreshBundleMessage {
  type: typeof REFRESH_MESSAGE;
}

interface ResetBundleMessage {
  type: typeof RESET_MESSAGE;
}

type WorkerRequest = ActivateBundleMessage | RefreshBundleMessage | ResetBundleMessage;

type WorkerReply = { ok: true; revision?: number } | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkerRequest(value: unknown): WorkerRequest | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === REFRESH_MESSAGE || value.type === RESET_MESSAGE) return { type: value.type };
  if (
    value.type !== ACTIVATE_MESSAGE ||
    typeof value.publicKey !== 'string' ||
    !Number.isSafeInteger(value.minimumRevision) ||
    Number(value.minimumRevision) < 1
  ) {
    return undefined;
  }
  return { type: ACTIVATE_MESSAGE, publicKey: value.publicKey, minimumRevision: Number(value.minimumRevision) };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function manifestDigest(manifest: Parameters<typeof canonicalManifest>[0]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifest(manifest));
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function trustedNetworkPath(pathname: string): boolean {
  return (
    pathname === '/pair' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/pwa/') ||
    pathname.startsWith('/api/') ||
    pathname === BUNDLE_MANIFEST_ROUTE ||
    pathname.startsWith(RAW_BUNDLE_PREFIX)
  );
}

async function verifiedResponse(state: ActiveBundleState, request: Request): Promise<Response> {
  const cache = await caches.open(state.cacheName);
  const url = new URL(request.url);
  const key = request.mode === 'navigate' ? '/index.html' : url.pathname;
  const cached = await cache.match(key);
  return cached ?? new Response('That verified cockpit asset is unavailable.', { status: 404 });
}

async function fetchManifest(): Promise<unknown> {
  const response = await fetch(BUNDLE_MANIFEST_ROUTE, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`The signed manifest request failed (${String(response.status)}).`);
  return await response.json();
}

async function activateBundle(publicKey: string, minimumRevision: number): Promise<WorkerReply> {
  const previous = await readActiveBundle();
  if (previous !== undefined && previous.signerPublicKey !== publicKey) {
    return { ok: false, code: 'signer-mismatch', message: 'The host signing key does not match the pinned key.' };
  }

  let envelope: unknown;
  try {
    envelope = await fetchManifest();
  } catch (error) {
    return { ok: false, code: 'manifest-fetch', message: error instanceof Error ? error.message : String(error) };
  }

  const floor = Math.max(minimumRevision, previous?.revision ?? 0);
  const verified = await verifySignedBundleManifest(envelope, publicKey, floor);
  if (!verified.ok)
    return { ok: false, code: verified.failure.code, message: 'The signed bundle manifest was refused.' };
  const digest = await manifestDigest(verified.manifest);
  if (previous?.revision === verified.manifest.revision) {
    if (previous.manifestDigest !== digest) {
      return {
        ok: false,
        code: 'revision-conflict',
        message: 'The host reused a revision for different bundle bytes.',
      };
    }
    if (await caches.has(previous.cacheName)) return { ok: true, revision: previous.revision };
  }

  const cacheName = `${CACHE_PREFIX}${String(verified.manifest.revision)}-${digest.slice(0, 16)}`;
  await caches.delete(cacheName);
  const staging = await caches.open(cacheName);
  try {
    for (const asset of verified.manifest.assets) {
      const source = `${RAW_BUNDLE_PREFIX}${String(verified.manifest.revision)}${asset.path}`;
      const response = await fetch(source, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok || response.redirected || new URL(response.url).origin !== worker.location.origin) {
        throw new Error(`The raw bundle asset ${asset.path} was unavailable.`);
      }
      const bytes = await response.arrayBuffer();
      const assetResult = await verifyBundleAsset(verified.manifest, asset.path, bytes);
      if (!assetResult.ok) throw new Error(`The raw bundle asset ${asset.path} failed ${assetResult.failure.code}.`);
      await staging.put(
        asset.path,
        new Response(bytes, {
          status: 200,
          headers: {
            'Cache-Control': 'no-store',
            'Content-Length': String(asset.byteLength),
            'Content-Type': asset.contentType,
            'X-Content-Type-Options': 'nosniff',
          },
        }),
      );
    }

    const next: ActiveBundleState = {
      signerPublicKey: publicKey,
      manifestDigest: digest,
      revision: verified.manifest.revision,
      cacheName,
    };
    await commitActiveBundle(next);
    for (const held of await caches.keys()) {
      if (held.startsWith(CACHE_PREFIX) && held !== next.cacheName && held !== previous?.cacheName)
        await caches.delete(held);
    }
    return { ok: true, revision: next.revision };
  } catch (error) {
    await caches.delete(cacheName);
    return { ok: false, code: 'asset-verification', message: error instanceof Error ? error.message : String(error) };
  }
}

async function handleMessage(request: WorkerRequest): Promise<WorkerReply> {
  if (request.type === RESET_MESSAGE) {
    for (const held of await caches.keys()) {
      if (held.startsWith(CACHE_PREFIX)) await caches.delete(held);
    }
    await clearActiveBundle();
    return { ok: true };
  }
  if (request.type === ACTIVATE_MESSAGE) {
    return await activateBundle(request.publicKey, request.minimumRevision);
  }
  const current = await readActiveBundle();
  if (current === undefined) return { ok: false, code: 'no-pin', message: 'No host signing key is pinned.' };
  return await activateBundle(current.signerPublicKey, current.revision);
}

worker.addEventListener('install', (event) => {
  event.waitUntil(worker.skipWaiting());
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('message', (event) => {
  const request = parseWorkerRequest(event.data);
  const port = event.ports[0];
  if (port === undefined) return;
  if (request === undefined) {
    port.postMessage({
      ok: false,
      code: 'invalid-request',
      message: 'The worker request was malformed.',
    } satisfies WorkerReply);
    return;
  }
  event.waitUntil(
    handleMessage(request)
      .then((reply) => port.postMessage(reply))
      .catch((error: unknown) =>
        port.postMessage({
          ok: false,
          code: 'worker-failure',
          message: error instanceof Error ? error.message : String(error),
        } satisfies WorkerReply),
      ),
  );
});

/**
 * The revalidation in flight, so several tabs opening at once ask one question.
 *
 * Cleared when it settles rather than cached: the next navigation is a new
 * moment and deserves a fresh answer.
 */
let revalidation: Promise<void> | undefined;

async function announceRevision(revision: number): Promise<void> {
  const windows = await worker.clients.matchAll({ type: 'window' });
  for (const client of windows) {
    client.postMessage({ type: BUNDLE_UPDATED_MESSAGE, revision } satisfies BundleUpdatedMessage);
  }
}

/**
 * Asks the host whether the pinned bundle is still the current one.
 *
 * Runs through `activateBundle` unchanged, so signer pinning, the monotonic
 * revision floor, revision-reuse detection and per-asset verification all still
 * decide the outcome. Every failure is deliberately silent: the page is already
 * being served the last verified bundle, and a refused update must not disturb
 * a cockpit that works.
 */
function revalidatePinnedBundle(state: ActiveBundleState): Promise<void> {
  revalidation ??= (async () => {
    try {
      const reply = await activateBundle(state.signerPublicKey, state.revision);
      if (reply.ok && reply.revision !== undefined && reply.revision > state.revision) {
        await announceRevision(reply.revision);
      }
    } catch {
      // A revalidation that throws leaves the pin and the cache untouched.
    } finally {
      revalidation = undefined;
    }
  })();
  return revalidation;
}

/** Reads the pin itself, so scheduling never has to wait on the response path. */
async function revalidateOnNavigation(): Promise<void> {
  const state = await readActiveBundle();
  if (state === undefined) return;
  await revalidatePinnedBundle(state);
}

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin || trustedNetworkPath(url.pathname)) return;
  // A navigation is the one moment a returning device is reliably online and
  // between pages, so it is where the pin gets questioned. Scheduled here, while
  // the event is certainly still extendable, and kept off the response path: a
  // refused or impossible update must never cost the page its bundle.
  if (event.request.mode === 'navigate') event.waitUntil(revalidateOnNavigation());
  event.respondWith(
    readActiveBundle().then(async (state) =>
      state === undefined ? await fetch(event.request) : await verifiedResponse(state, event.request),
    ),
  );
});

worker.addEventListener('push', (event) => {
  let body = 'A live session needs your attention.';
  try {
    const payload: unknown = event.data?.json();
    if (isRecord(payload) && payload.body === body) body = payload.body;
  } catch {
    // Payloads are deliberately generic; malformed data falls back to the same copy.
  }
  event.waitUntil(
    worker.registration.showNotification('DoomPi', {
      body,
      tag: 'doompi-live',
      icon: '/pwa/icon-192.png',
      badge: '/pwa/icon-192.png',
      data: { url: '/' },
    }),
  );
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    worker.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === worker.location.origin);
      if (existing !== undefined) {
        await existing.focus();
        return;
      }
      await worker.clients.openWindow('/');
    }),
  );
});
