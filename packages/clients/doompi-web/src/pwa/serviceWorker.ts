/// <reference lib="webworker" />

import { BUNDLE_ASSET_POLICY_PATH, parseBundleAssetPolicy } from '@agimon-ai/doompi-core/web';
import {
  BUNDLE_MANIFEST_ROUTE,
  type BundleAsset,
  type BundleManifest,
  canonicalManifest,
  type SignedBundleManifest,
  verifyBundleAsset,
  verifySignedBundleManifest,
} from '@agimon-ai/doompi-web-security/browser';

import { BUNDLE_UPDATED_MESSAGE, type BundleUpdatedMessage } from '../types/bundle';
import {
  clearActiveBundle,
  clearVerifiedPluginComposition,
  commitActiveBundle,
  commitVerifiedPluginComposition,
  listVerifiedPluginCompositions,
  readActiveBundle,
  readVerifiedPluginComposition,
  type ActiveBundleState,
  type VerifiedPluginCompositionState,
} from './bundleCache';
import { RAW_BUNDLE_PREFIX, trustedNetworkPath } from './networkPaths';

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE_PREFIX = 'doompi-bundle-';
const PLUGIN_CACHE_PREFIX = 'doompi-plugin-';
const PLUGIN_NETWORK_PREFIX = '/api/web-plugins/';
const VERIFIED_PLUGIN_PREFIX = '/verified-plugins/';
const MAX_VERIFIED_PLUGIN_COMPOSITIONS = 16;
const ACTIVATE_MESSAGE = 'doompi:activate-bundle';
const ACTIVATE_PLUGIN_MESSAGE = 'doompi:activate-plugin-composition';
const REFRESH_MESSAGE = 'doompi:refresh-bundle';
const RESET_MESSAGE = 'doompi:reset-bundle-trust';
const PLUGIN_FETCH_MESSAGE = 'doompi:plugin-fetch';
const PLUGIN_FETCH_RESULT_MESSAGE = 'doompi:plugin-fetch-result';
const PLUGIN_FETCH_TIMEOUT_MS = 120_000;
const ASSET_FETCH_CONCURRENCY = 4;

interface ActivateBundleMessage {
  type: typeof ACTIVATE_MESSAGE;
  publicKey: string;
  minimumRevision: number;
}

interface RefreshBundleMessage {
  type: typeof REFRESH_MESSAGE;
}

interface ActivatePluginCompositionMessage {
  type: typeof ACTIVATE_PLUGIN_MESSAGE;
  compositionId: string;
  revision: number;
  manifestUrl: string;
  rawAssetBaseUrl: string;
  verifiedAssetBaseUrl: string;
  relayThroughClient: boolean;
}

interface ResetBundleMessage {
  type: typeof RESET_MESSAGE;
}

type WorkerRequest =
  | ActivateBundleMessage
  | ActivatePluginCompositionMessage
  | RefreshBundleMessage
  | ResetBundleMessage;

type WorkerReply = { ok: true; revision?: number } | { ok: false; code: string; message: string };

type PluginFetchResult =
  | {
      type: typeof PLUGIN_FETCH_RESULT_MESSAGE;
      requestId: number;
      ok: true;
      status: number;
      headers: Array<[string, string]>;
      body: ArrayBuffer;
    }
  | { type: typeof PLUGIN_FETCH_RESULT_MESSAGE; requestId: number; ok: false; message: string };

let pluginFetchRequestId = 0;

function parsePluginFetchResult(value: unknown, requestId: number): PluginFetchResult | undefined {
  if (!isRecord(value) || value.type !== PLUGIN_FETCH_RESULT_MESSAGE || value.requestId !== requestId) return undefined;
  if (value.ok === false && typeof value.message === 'string') return value as PluginFetchResult;
  if (
    value.ok !== true ||
    typeof value.status !== 'number' ||
    !Array.isArray(value.headers) ||
    !value.headers.every(
      (header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === 'string'),
    ) ||
    !(value.body instanceof ArrayBuffer)
  ) {
    return undefined;
  }
  return value as PluginFetchResult;
}

async function fetchPluginDirect(path: string): Promise<Response> {
  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
  });
  if (response.redirected || new URL(response.url).origin !== worker.location.origin) {
    throw new Error('The plugin asset request left the trusted origin.');
  }
  return response;
}

async function fetchThroughClient(port: MessagePort, path: string): Promise<Response> {
  const requestId = ++pluginFetchRequestId;
  return await new Promise((resolve, reject) => {
    const timeout = worker.setTimeout(() => {
      port.removeEventListener('message', onMessage);
      reject(new Error('The cockpit page did not answer the plugin asset request.'));
    }, PLUGIN_FETCH_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<unknown>): void => {
      const result = parsePluginFetchResult(event.data, requestId);
      if (result === undefined) return;
      worker.clearTimeout(timeout);
      port.removeEventListener('message', onMessage);
      if (!result.ok) {
        reject(new Error(result.message));
        return;
      }
      resolve(new Response(result.body, { status: result.status, headers: result.headers }));
    };
    port.addEventListener('message', onMessage);
    port.start();
    port.postMessage({ type: PLUGIN_FETCH_MESSAGE, requestId, path });
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkerRequest(value: unknown): WorkerRequest | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === REFRESH_MESSAGE || value.type === RESET_MESSAGE) return { type: value.type };
  if (value.type === ACTIVATE_PLUGIN_MESSAGE) {
    if (
      typeof value.compositionId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.compositionId) ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      typeof value.manifestUrl !== 'string' ||
      typeof value.rawAssetBaseUrl !== 'string' ||
      typeof value.verifiedAssetBaseUrl !== 'string' ||
      typeof value.relayThroughClient !== 'boolean'
    ) {
      return undefined;
    }
    const revision = Number(value.revision);
    const route = `${PLUGIN_NETWORK_PREFIX}${value.compositionId}/${String(revision)}`;
    const verified = `${VERIFIED_PLUGIN_PREFIX}${value.compositionId}/${String(revision)}`;
    if (
      value.manifestUrl !== `${route}/manifest` ||
      value.rawAssetBaseUrl !== `${route}/assets` ||
      value.verifiedAssetBaseUrl !== verified
    ) {
      return undefined;
    }
    return {
      type: ACTIVATE_PLUGIN_MESSAGE,
      compositionId: value.compositionId,
      revision,
      manifestUrl: value.manifestUrl,
      rawAssetBaseUrl: value.rawAssetBaseUrl,
      verifiedAssetBaseUrl: value.verifiedAssetBaseUrl,
      relayThroughClient: value.relayThroughClient,
    };
  }
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

function assetResponse(asset: BundleAsset, bytes: ArrayBuffer): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Length': String(asset.byteLength),
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const optionalFetches = new Map<string, Promise<Response>>();
const assetControllers = new Set<AbortController>();
const assetWaiters: Array<() => void> = [];
let activeAssetFetches = 0;
let trustEpoch = 0;
let trustOperation: Promise<unknown> = Promise.resolve();

function queueTrustOperation<T>(operation: (epoch: number) => Promise<T>): Promise<T> {
  const epoch = trustEpoch;
  const queued = trustOperation.then(
    async () => await operation(epoch),
    async () => await operation(epoch),
  );
  trustOperation = queued;
  return queued;
}

async function fetchRawAsset(manifest: BundleManifest, asset: BundleAsset): Promise<ArrayBuffer> {
  const epoch = trustEpoch;
  if (activeAssetFetches >= ASSET_FETCH_CONCURRENCY) {
    await new Promise<void>((resolve) => assetWaiters.push(resolve));
  } else activeAssetFetches += 1;
  const controller = new AbortController();
  assetControllers.add(controller);
  try {
    if (epoch !== trustEpoch) throw new Error('Bundle trust changed before the asset download.');
    const source = `${RAW_BUNDLE_PREFIX}${String(manifest.revision)}${asset.path}`;
    const response = await fetch(source, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const responseUrl = new URL(response.url);
    if (
      !response.ok ||
      response.redirected ||
      responseUrl.origin !== worker.location.origin ||
      responseUrl.pathname !== source
    ) {
      throw new Error(`The raw bundle asset ${asset.path} was unavailable.`);
    }
    const bytes = await response.arrayBuffer();
    const result = await verifyBundleAsset(manifest, asset.path, bytes);
    if (!result.ok) throw new Error(`The raw bundle asset ${asset.path} failed ${result.failure.code}.`);
    return bytes;
  } finally {
    assetControllers.delete(controller);
    const next = assetWaiters.shift();
    if (next === undefined) activeAssetFetches -= 1;
    else next();
  }
}

async function verifiedCachedBytes(
  cache: Cache | undefined,
  manifest: BundleManifest,
  asset: BundleAsset,
): Promise<ArrayBuffer | undefined> {
  const cached = await cache?.match(asset.path);
  if (cached === undefined || cached.status !== 200) return undefined;
  const bytes = await cached.arrayBuffer();
  return (await verifyBundleAsset(manifest, asset.path, bytes)).ok ? bytes : undefined;
}

async function runBounded<T>(values: readonly T[], operation: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(ASSET_FETCH_CONCURRENCY, values.length) }, async () => {
      while (!failed && index < values.length) {
        const value = values[index++];
        try {
          if (value !== undefined) await operation(value);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') {
    const error: unknown = rejected.reason;
    throw error instanceof Error ? error : new Error('An asset operation failed.', { cause: error });
  }
}

function optionalPaths(manifest: BundleManifest, bytes: ArrayBuffer): string[] {
  try {
    const policy = parseBundleAssetPolicy(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    if (
      policy !== undefined &&
      policy.optional.every(
        (assetPath) =>
          assetPath !== '/index.html' &&
          assetPath !== BUNDLE_ASSET_POLICY_PATH &&
          manifest.assets.some((asset) => asset.path === assetPath),
      )
    ) {
      return policy.optional;
    }
  } catch {
    // Authenticated but unsupported policy means eager activation, never an integrity bypass.
  }
  return [];
}

async function verifiedStateManifest(state: ActiveBundleState): Promise<BundleManifest | undefined> {
  const verified = await verifySignedBundleManifest(state.signedManifest, state.signerPublicKey, state.revision);
  if (
    !verified.ok ||
    verified.manifest.revision !== state.revision ||
    (await manifestDigest(verified.manifest)) !== state.manifestDigest
  )
    return undefined;
  return verified.manifest;
}

async function lazyVerifiedResponse(
  state: ActiveBundleState,
  manifest: BundleManifest,
  asset: BundleAsset,
): Promise<Response> {
  const key = `${state.cacheName}:${state.manifestDigest}:${asset.path}`;
  const existing = optionalFetches.get(key);
  if (existing !== undefined) return (await existing).clone();
  const epoch = trustEpoch;
  const fetching = (async () => {
    const bytes = await fetchRawAsset(manifest, asset);
    const current = await readActiveBundle();
    if (
      epoch !== trustEpoch ||
      current?.cacheName !== state.cacheName ||
      current.manifestDigest !== state.manifestDigest
    ) {
      throw new Error('The active bundle changed while the optional asset was downloading.');
    }
    const response = assetResponse(asset, bytes);
    const cache = await caches.open(state.cacheName);
    await cache.put(asset.path, response.clone());
    const committed = await readActiveBundle();
    if (
      epoch !== trustEpoch ||
      committed?.cacheName !== state.cacheName ||
      committed.manifestDigest !== state.manifestDigest
    ) {
      if (epoch !== trustEpoch) await caches.delete(state.cacheName);
      else await cache.delete(asset.path);
      throw new Error('The active bundle changed while the optional asset was being cached.');
    }
    return response;
  })();
  optionalFetches.set(key, fetching);
  try {
    return (await fetching).clone();
  } finally {
    if (optionalFetches.get(key) === fetching) optionalFetches.delete(key);
  }
}

async function verifiedResponse(state: ActiveBundleState, request: Request): Promise<Response> {
  const unavailable = () => new Response('That verified cockpit asset is unavailable.', { status: 404 });
  if (request.method !== 'GET')
    return new Response('Only GET assets are supported.', { status: 405, headers: { Allow: 'GET' } });
  const cache = await caches.open(state.cacheName);
  const key = request.mode === 'navigate' ? '/index.html' : new URL(request.url).pathname;
  if (state.signedManifest === undefined) {
    // Old complete caches retain their original offline contract, but cannot authorize new downloads.
    if (state.manifest !== undefined || state.optionalAssetPaths !== undefined) return unavailable();
    return (await cache.match(key)) ?? unavailable();
  }
  const manifest = await verifiedStateManifest(state);
  const asset = manifest?.assets.find((candidate) => candidate.path === key);
  if (manifest === undefined || asset === undefined) return unavailable();
  const bytes = await verifiedCachedBytes(cache, manifest, asset);
  if (bytes !== undefined) return assetResponse(asset, bytes);
  const policyAsset = manifest.assets.find((candidate) => candidate.path === BUNDLE_ASSET_POLICY_PATH);
  const policyBytes = policyAsset === undefined ? undefined : await verifiedCachedBytes(cache, manifest, policyAsset);
  if (policyBytes === undefined || !optionalPaths(manifest, policyBytes).includes(key)) return unavailable();
  try {
    return await lazyVerifiedResponse(state, manifest, asset);
  } catch {
    await revalidatePinnedBundle(state);
    return unavailable();
  }
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

async function fetchPluginManifest(
  manifestUrl: string,
  fetchPlugin: (path: string) => Promise<Response>,
): Promise<unknown> {
  const response = await fetchPlugin(manifestUrl);
  if (!response.ok) throw new Error(`The signed plugin manifest request failed (${String(response.status)}).`);
  return await response.json();
}

async function prunePluginCompositions(): Promise<void> {
  const states = (await listVerifiedPluginCompositions()).sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  for (const stale of states.slice(MAX_VERIFIED_PLUGIN_COMPOSITIONS)) {
    try {
      await clearVerifiedPluginComposition(stale.compositionId);
      await caches.delete(stale.cacheName);
    } catch {
      // A later activation retries pruning. Never invalidate the composition being activated.
    }
  }
}

async function activatePluginComposition(
  request: ActivatePluginCompositionMessage,
  fetchPlugin: (path: string) => Promise<Response>,
  expectedEpoch: number,
): Promise<WorkerReply> {
  if (expectedEpoch !== trustEpoch) return { ok: false, code: 'trust-reset', message: 'Bundle trust was reset.' };
  const host = await readActiveBundle();
  if (host === undefined) {
    return { ok: false, code: 'no-pin', message: 'No trusted cockpit signing key is pinned.' };
  }
  const previous = await readVerifiedPluginComposition(request.compositionId);
  if (previous !== undefined && previous.signerPublicKey !== host.signerPublicKey) {
    return { ok: false, code: 'signer-mismatch', message: 'The plugin signer does not match the cockpit signer.' };
  }

  let envelope: unknown;
  try {
    envelope = await fetchPluginManifest(request.manifestUrl, fetchPlugin);
  } catch (error) {
    return { ok: false, code: 'manifest-fetch', message: error instanceof Error ? error.message : String(error) };
  }
  const verified = await verifySignedBundleManifest(envelope, host.signerPublicKey, request.revision);
  if (!verified.ok || verified.manifest.revision !== request.revision) {
    return { ok: false, code: 'manifest-verification', message: 'The signed plugin manifest was refused.' };
  }
  const digest = await manifestDigest(verified.manifest);
  if (previous?.revision === request.revision) {
    if (previous.manifestDigest !== digest) {
      return { ok: false, code: 'revision-conflict', message: 'The plugin revision was reused for different bytes.' };
    }
    if (await caches.has(previous.cacheName)) {
      if (expectedEpoch !== trustEpoch) return { ok: false, code: 'trust-reset', message: 'Bundle trust was reset.' };
      await commitVerifiedPluginComposition({ ...previous, lastUsedAt: Date.now() });
      if (expectedEpoch !== trustEpoch) return { ok: false, code: 'trust-reset', message: 'Bundle trust was reset.' };
      return { ok: true, revision: previous.revision };
    }
  }

  const cacheName = `${PLUGIN_CACHE_PREFIX}${request.compositionId}-${String(request.revision)}-${digest.slice(0, 16)}`;
  await caches.delete(cacheName);
  const staging = await caches.open(cacheName);
  try {
    for (const asset of verified.manifest.assets) {
      const source = `${request.rawAssetBaseUrl}${asset.path}`;
      const response = await fetchPlugin(source);
      if (!response.ok) throw new Error(`The raw plugin asset ${asset.path} was unavailable.`);
      const bytes = await response.arrayBuffer();
      const assetResult = await verifyBundleAsset(verified.manifest, asset.path, bytes);
      if (!assetResult.ok) throw new Error(`The raw plugin asset ${asset.path} failed ${assetResult.failure.code}.`);
      await staging.put(
        `${request.verifiedAssetBaseUrl}${asset.path}`,
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
    const next: VerifiedPluginCompositionState = {
      compositionId: request.compositionId,
      signerPublicKey: host.signerPublicKey,
      manifestDigest: digest,
      revision: request.revision,
      cacheName,
      verifiedAssetBaseUrl: request.verifiedAssetBaseUrl,
      lastUsedAt: Date.now(),
    };
    if (expectedEpoch !== trustEpoch) throw new Error('Bundle trust was reset during plugin activation.');
    await commitVerifiedPluginComposition(next);
    if (expectedEpoch !== trustEpoch) throw new Error('Bundle trust was reset during plugin activation.');
    try {
      if (previous !== undefined && previous.cacheName !== next.cacheName) await caches.delete(previous.cacheName);
      await prunePluginCompositions();
    } catch {
      // The committed cache is usable. Cleanup is best effort and must not roll it back.
    }
    return { ok: true, revision: next.revision };
  } catch (error) {
    await caches.delete(cacheName);
    if (expectedEpoch !== trustEpoch) return { ok: false, code: 'trust-reset', message: 'Bundle trust was reset.' };
    return { ok: false, code: 'asset-verification', message: error instanceof Error ? error.message : String(error) };
  }
}

const pluginActivations = new Map<string, Promise<WorkerReply>>();

function queuePluginActivation(
  request: ActivatePluginCompositionMessage,
  fetchPlugin: (path: string) => Promise<Response>,
  expectedEpoch: number,
): Promise<WorkerReply> {
  const previous = pluginActivations.get(request.compositionId) ?? Promise.resolve({ ok: true } as WorkerReply);
  const activation = previous.then(
    async () => await activatePluginComposition(request, fetchPlugin, expectedEpoch),
    async () => await activatePluginComposition(request, fetchPlugin, expectedEpoch),
  );
  pluginActivations.set(request.compositionId, activation);
  void activation.then(
    () => {
      if (pluginActivations.get(request.compositionId) === activation) pluginActivations.delete(request.compositionId);
    },
    () => {
      if (pluginActivations.get(request.compositionId) === activation) pluginActivations.delete(request.compositionId);
    },
  );
  return activation;
}

async function verifiedPluginResponse(request: Request): Promise<Response> {
  const expectedEpoch = trustEpoch;
  const host = await readActiveBundle();
  const url = new URL(request.url);
  const [compositionId, revisionText] = url.pathname.slice(VERIFIED_PLUGIN_PREFIX.length).split('/', 2);
  if (compositionId === undefined || revisionText === undefined) {
    return new Response('That verified plugin asset is unavailable.', { status: 404 });
  }
  const state = await readVerifiedPluginComposition(compositionId);
  if (
    host === undefined ||
    state === undefined ||
    state.signerPublicKey !== host.signerPublicKey ||
    String(state.revision) !== revisionText ||
    !url.pathname.startsWith(`${state.verifiedAssetBaseUrl}/`)
  ) {
    return new Response('That verified plugin asset is unavailable.', { status: 404 });
  }
  const cache = await caches.open(state.cacheName);
  const response = await cache.match(url.pathname);
  return expectedEpoch === trustEpoch && response !== undefined
    ? response
    : new Response('That verified plugin asset is unavailable.', { status: 404 });
}

async function activateBundle(publicKey: string, minimumRevision: number, expectedEpoch: number): Promise<WorkerReply> {
  if (expectedEpoch !== trustEpoch) return { ok: false, code: 'trust-reset', message: 'Bundle trust was reset.' };
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
  if (previous?.revision === verified.manifest.revision && previous.manifestDigest !== digest) {
    return {
      ok: false,
      code: 'revision-conflict',
      message: 'The host reused a revision for different bundle bytes.',
    };
  }

  const cacheName = `${CACHE_PREFIX}${String(verified.manifest.revision)}-${digest.slice(0, 16)}-${crypto.randomUUID()}`;
  const staging = await caches.open(cacheName);
  const reusable =
    previous !== undefined && (await caches.has(previous.cacheName))
      ? await caches.open(previous.cacheName)
      : undefined;
  try {
    const policyAsset = verified.manifest.assets.find((asset) => asset.path === BUNDLE_ASSET_POLICY_PATH);
    let optionalAssetPaths: string[] = [];
    if (policyAsset !== undefined) {
      const policyBytes =
        (await verifiedCachedBytes(reusable, verified.manifest, policyAsset)) ??
        (await fetchRawAsset(verified.manifest, policyAsset));
      await staging.put(policyAsset.path, assetResponse(policyAsset, policyBytes));
      optionalAssetPaths = optionalPaths(verified.manifest, policyBytes);
    }

    const optional = new Set(optionalAssetPaths);
    const required = verified.manifest.assets.filter(
      (asset) => asset.path !== BUNDLE_ASSET_POLICY_PATH && !optional.has(asset.path),
    );
    if (
      previous?.revision === verified.manifest.revision &&
      reusable !== undefined &&
      (policyAsset === undefined || (await verifiedCachedBytes(reusable, verified.manifest, policyAsset)) !== undefined)
    ) {
      let complete = true;
      await runBounded(required, async (asset) => {
        if ((await verifiedCachedBytes(reusable, verified.manifest, asset)) === undefined) complete = false;
      });
      if (complete) {
        if (expectedEpoch !== trustEpoch) throw new Error('Bundle trust was reset during activation.');
        await commitActiveBundle({
          ...previous,
          manifest: verified.manifest,
          signedManifest: envelope as SignedBundleManifest,
          optionalAssetPaths,
        });
        try {
          await caches.delete(cacheName);
        } catch {
          /* The active cache is untouched; staging cleanup is best effort. */
        }
        return { ok: true, revision: previous.revision };
      }
    }
    await runBounded(required, async (asset) => {
      const bytes =
        (await verifiedCachedBytes(reusable, verified.manifest, asset)) ??
        (await fetchRawAsset(verified.manifest, asset));
      await staging.put(asset.path, assetResponse(asset, bytes));
    });

    // Reusable optional bytes improve offline updates, but a failed optional copy cannot block core activation.
    await runBounded(
      verified.manifest.assets.filter((asset) => optional.has(asset.path)),
      async (asset) => {
        try {
          const bytes = await verifiedCachedBytes(reusable, verified.manifest, asset);
          if (bytes !== undefined) await staging.put(asset.path, assetResponse(asset, bytes));
        } catch {
          // The optional asset remains lazy and can be fetched on demand.
        }
      },
    );

    if (expectedEpoch !== trustEpoch) throw new Error('Bundle trust was reset during activation.');
    const next: ActiveBundleState = {
      signerPublicKey: publicKey,
      manifestDigest: digest,
      revision: verified.manifest.revision,
      cacheName,
      manifest: verified.manifest,
      signedManifest: envelope as SignedBundleManifest,
      optionalAssetPaths,
    };
    await commitActiveBundle(next);
    try {
      for (const held of await caches.keys()) {
        if (held.startsWith(CACHE_PREFIX) && held !== next.cacheName && held !== previous?.cacheName) {
          await caches.delete(held);
        }
      }
    } catch {
      // The new core is committed. A later activation retries best-effort cleanup.
    }
    if (previous !== undefined && next.revision > previous.revision) {
      try {
        await announceRevision(next.revision, expectedEpoch);
      } catch {
        /* A closed client cannot roll back committed assets. */
      }
    }
    return { ok: true, revision: next.revision };
  } catch (error) {
    await caches.delete(cacheName);
    return { ok: false, code: 'asset-verification', message: error instanceof Error ? error.message : String(error) };
  }
}

async function resetBundleTrust(): Promise<WorkerReply> {
  await clearActiveBundle();
  try {
    for (const plugin of await listVerifiedPluginCompositions()) {
      await clearVerifiedPluginComposition(plugin.compositionId);
    }
  } catch {
    // Durable host trust is already cleared. Plugin record cleanup is best effort.
  }
  try {
    for (const held of await caches.keys()) {
      if (held.startsWith(CACHE_PREFIX) || held.startsWith(PLUGIN_CACHE_PREFIX)) await caches.delete(held);
    }
  } catch {
    // Durable host trust is already cleared. Cache cleanup is best effort.
  }
  return { ok: true };
}

async function handleMessage(request: WorkerRequest, port: MessagePort): Promise<WorkerReply> {
  if (request.type === RESET_MESSAGE) {
    trustEpoch += 1;
    for (const controller of assetControllers) controller.abort();
    return await queueTrustOperation(async () => await resetBundleTrust());
  }
  if (request.type === ACTIVATE_MESSAGE) {
    return await queueTrustOperation(
      async (epoch) => await activateBundle(request.publicKey, request.minimumRevision, epoch),
    );
  }
  if (request.type === ACTIVATE_PLUGIN_MESSAGE) {
    const fetchPlugin = request.relayThroughClient
      ? (path: string) => fetchThroughClient(port, path)
      : fetchPluginDirect;
    return await queueTrustOperation(async (epoch) => await queuePluginActivation(request, fetchPlugin, epoch));
  }
  return await queueTrustOperation(async (epoch) => {
    const current = await readActiveBundle();
    if (current === undefined) return { ok: false, code: 'no-pin', message: 'No host signing key is pinned.' };
    return await activateBundle(current.signerPublicKey, current.revision, epoch);
  });
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
    handleMessage(request, port)
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

async function announceRevision(revision: number, epoch: number): Promise<void> {
  const windows = await worker.clients.matchAll({ type: 'window' });
  for (const client of windows) {
    if (epoch === trustEpoch)
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
      await queueTrustOperation(async (epoch) => {
        const current = await readActiveBundle();
        if (
          current === undefined ||
          current.cacheName !== state.cacheName ||
          current.signerPublicKey !== state.signerPublicKey
        )
          return;
        await activateBundle(current.signerPublicKey, current.revision, epoch);
      });
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
  if (url.origin !== worker.location.origin) return;
  if (url.pathname.startsWith(VERIFIED_PLUGIN_PREFIX)) {
    event.respondWith(verifiedPluginResponse(event.request));
    return;
  }
  if (trustedNetworkPath(url.pathname)) return;
  // The development shell stays on Vite; plugin assets above still require verification.
  if (
    new URLSearchParams(worker.location.search).get('development') === '1' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(worker.location.hostname)
  )
    return;
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
