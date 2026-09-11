import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Server } from '@earendil-works/pi-server';
import { readSyncDrift, readSyncRegistration, type SyncRegistration } from '@agimon-ai/doompi/services';
import { layerHookGroups, loadMajorModesConfig, readHarnessState, resolveLayers } from '@agimon-ai/doompi/config';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config';
import { readSyncState, type SyncState } from '@agimon-ai/doompi/services/syncState';
import type { DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { DOOM_COCKPIT_SERVER_ID } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { BUNDLE_MANIFEST_ROUTE, assetFor } from '@agimon-ai/doompi-web-security';
import { packagedVersion } from './packageVersion.ts';
import { createPiHubService } from './piHubService.ts';
import { createHubProtocol } from './hubProtocol.ts';
import type { WSEvents } from 'hono/ws';
import { createFederationStore } from './federationStore.ts';
import { registerFederationRoutes } from './federationRoutes.ts';
import {
  createFederationTransport,
  FEDERATION_PROTOCOL_ROUTE,
  FEDERATION_TRANSPORT_ROUTE,
} from './federationTransport.ts';
import { createFederationProtocol } from './federationProtocol.ts';
import { createFederationDirectory } from './federationDirectory.ts';
import { createSyncGuard } from './syncGuard.ts';
import { createPiWebSocketListener } from './piWebSocketListener.ts';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import {
  DOOM_API_ROUTE_PREFIX,
  DOOM_HUB_API_SESSION_QUERY_PARAM,
  type DoomApi,
  type DoomApiCaller,
  type DoomApiContext,
  type DoomOAuthRedirect,
  type DoomRepositorySyncView,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { loadPackageApis, PACKAGE_API_DIR_ENV } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import {
  createDoomServerHost,
  type DoomServerFacet,
  type DoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import {
  type InstalledServerFacets,
  installServerFacets,
  type LoadedServerFacet,
  loadServerBundle,
  loadServerFacets,
  resolveServerBundleSource,
} from '@agimon-ai/doompi-extension-contracts/server-facet-loader';
import { insideSandbox } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { findRepositoryRoot, resolveDoomConfigurationRoot } from '@agimon-ai/doompi/utils/repository';
import { sessionFileHeaders } from '../services/fileMedia.ts';
import { sessionBundleSelection, sessionBundleKey } from './sessionBundleSelection.ts';
import type { SessionRecord } from '../types/registry.ts';
import { createOAuthRedirectRegistry } from '../services/oauthRedirectRegistry.ts';
import { contentTypeFor, resolveAssetPath } from '../services/staticAssets.ts';
import {
  MAX_SESSION_FILE_BYTES,
  SESSION_FILE_EXPECTED_SHA256_HEADER,
  SESSION_FILE_ROUTE,
  SESSION_FILE_SHA256_HEADER,
} from '../types/media.ts';
import { MCP_OAUTH_CALLBACK_ROUTE } from '../types/mcpOAuth.ts';
import type { SettingsRepository } from '../types/settings.ts';
import type { WebServer, WebServerOptions } from '../types/bridge.ts';
import {
  API_SESSION_QUERY_PARAM,
  DIRECTORIES_API_ROUTE,
  HISTORY_REQUEST_TYPE,
  HUB_PROTOCOL_VERSION,
  HUB_ROLE,
  SESSIONS_API_ROUTE,
  SESSIONS_SNAPSHOT_TYPE,
  SESSION_COMMAND_TYPE,
  SESSION_REMOVED_TYPE,
  SESSION_UPSERT_TYPE,
  SUBSCRIBE_THREAD_TYPE,
  SUBSCRIBE_TYPE,
  UNSUBSCRIBE_THREAD_TYPE,
  UNSUBSCRIBE_TYPE,
  hubHello,
  sessionFrameEnvelope,
  threadBacklog,
  threadFrameEnvelope,
} from '../types/hub.ts';
import { parseDoomNotificationEntry } from '../types/notification.ts';
import { ATTACH_TYPE, type SessionFrame } from '../types/session.ts';
import { readGitStatus } from './gitStatus.ts';
import { advertiseHub } from './hubAdvertisement.ts';
import { readSessionLineage } from './sessionLineage.ts';
import { readRegistryRecords, watchRegistry } from './registryWatcher.ts';
import { createServerSpawner } from './serverSpawner.ts';
import { createSessionHub, type SessionHub, type SessionHubOptions } from './sessionHub.ts';
import { allowedOriginsFromEnv } from '../services/remoteGuardPolicy.ts';
import { createRecordingArtifactStore } from '../services/recordingArtifacts.ts';
import { describeStranded, planSessionMigration } from '../services/sessionMigration.ts';
import { registerAuthRoutes } from './authRoutes.ts';
import { registerOAuthRedirectRoutes } from './oauthRedirectRoutes.ts';
import { registerSettingsRoutes } from './settingsRoutes.ts';
import { createProviderAuth } from './providerAuth.ts';
import { createRemoteGuard } from './remoteGuard.ts';
import { createRemoteAccess } from './remoteAccess.ts';
import { createBundlePublication, createPluginBundlePublication } from './bundlePublication.ts';
import { createLiveWebPush, type LiveWebPush } from './webPush.ts';
import { createRemoteAccessStore } from './remoteAccessStore.ts';
import { registerRemoteRoutes } from './remoteRoutes.ts';
import { registerDevProxyRoutes } from './devProxyRoutes.ts';
import { createDevProxyStore } from './devProxyStore.ts';
import { createTunnelLauncher, reapStaleTunnel } from './tunnelProcess.ts';
import {
  DEVICE_COOKIE,
  PAIRING_PAGE_ROUTE,
  PROTOCOL_SOCKET_ROUTE,
  REMOTE_CHANNEL_ROUTE,
  REMOTE_HTTP_ROUTE,
  REMOTE_PUSH_KEY_ROUTE,
  REMOTE_PUSH_ROUTE,
  SESSION_SOCKET_ROUTE,
  type RemoteAccessSettings,
} from '../types/remoteAccess.ts';
import { suggestDirectories } from './directoryListing.ts';
import { listSessionFiles, readSessionFile, writeSessionFile } from './sessionFiles.ts';
import { proxyToSocket } from './packageApiProxy.ts';
import { createThreadJournals } from './threadJournals.ts';
import { loadHubChannels } from './webHubPluginLoader.ts';
import {
  BROWSER_ERROR_EVENT,
  createBrowserError,
  createBrowserTelemetryRateLimit,
  createWebTelemetry,
  forwardedTraceContext,
  isBrowserErrorEvent,
  parseBrowserTelemetryBatch,
  readTraceContext,
  requestOperation,
  shutdownWebTelemetry,
  WEB_TELEMETRY_ROUTE,
} from './webTelemetry.ts';
import { resolveSessionWebArtifacts } from './sessionWebComposition.ts';

// Pi's protocol rides its own socket so the DoomPi channel keeps the
// vocabulary the protocol has no shape for: dialogs, minor modes, selection.
/** Directory suggestions per picker query; more than this means "type further". */
const DIRECTORY_SUGGESTION_LIMIT = 12;
const INDEX_FILE = 'index.html';
/** Env override for the assets directory, set by launchers that know a synced bundle. */
const WEB_DIST_ENV = 'DOOMPI_WEB_DIST';
/** Package-root override for bundled launchers whose chunks do not retain the npm layout. */
const WEB_PACKAGE_ROOT_ENV = 'DOOMPI_WEB_PACKAGE_ROOT';
/** Comma-separated origins the operator allows past the guard, for dev setups this package cannot guess. */
const ALLOW_ORIGIN_ENV = 'DOOMPI_WEB_ALLOW_ORIGIN';
const RAW_BUNDLE_PREFIX = '/bundle-assets/';
const PLUGIN_BUNDLE_PREFIX = '/api/web-plugins/';
const VERIFIED_PLUGIN_PREFIX = '/verified-plugins/';
const PWA_ASSET_PREFIX = '/pwa/';
const SEALED_HTTP_VERSION = 1;
/** Upper bound for any body accepted from the tunnel before route-specific limits. */
const TUNNEL_BODY_BYTES = 8 * 1024 * 1024;
const TUNNEL_HEADER_BYTES = 16 * 1024;
/**
 * A full telemetry batch of ten failures, each with a bounded stack, still fits
 * with room to spare. Anything larger is not a cockpit reporting itself.
 */
const BROWSER_TELEMETRY_BODY_BYTES = 32 * 1024;
const TUNNEL_HEADERS_TIMEOUT_MS = 5000;
const TUNNEL_REQUEST_TIMEOUT_MS = 10_000;
const TUNNEL_CONNECTION_LIMIT = 64;
const TUNNEL_REQUESTS_PER_SOCKET = 100;
const SEALED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SEALED_HTTP_FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

interface SealedRequestBindings {
  incoming?: { socket?: { localPort?: number } };
  sealedDeviceId?: string;
}

interface SealedHttpRequest {
  v: number;
  method: string;
  target: string;
  headers: Array<[string, string]>;
  body?: string;
}

function parseSealedHttpRequest(value: unknown): SealedHttpRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const request = value as Partial<SealedHttpRequest>;
  if (
    request.v !== SEALED_HTTP_VERSION ||
    typeof request.method !== 'string' ||
    !SEALED_HTTP_METHODS.has(request.method) ||
    typeof request.target !== 'string' ||
    !request.target.startsWith('/') ||
    request.target.startsWith('//') ||
    request.target.includes('#') ||
    !Array.isArray(request.headers) ||
    !request.headers.every(
      (header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === 'string'),
    ) ||
    (request.body !== undefined && typeof request.body !== 'string')
  ) {
    return undefined;
  }
  const target = new URL(request.target, 'http://sealed.doompi.invalid');
  if (target.pathname === REMOTE_HTTP_ROUTE || target.pathname === REMOTE_CHANNEL_ROUTE) return undefined;
  return request as SealedHttpRequest;
}

function sealedRequestHeaders(request: SealedHttpRequest, outer: Context): Headers | undefined {
  try {
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      const normalized = name.toLowerCase();
      if (SEALED_HTTP_FORBIDDEN_HEADERS.has(normalized) || normalized.startsWith('sec-')) continue;
      headers.append(name, value);
    }
    for (const name of ['cookie', 'host', 'origin'] as const) {
      const value = outer.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    return headers;
  } catch {
    return undefined;
  }
}

function decodeSealedHttpBody(value: string | undefined): Buffer | undefined {
  if (value === undefined) return Buffer.alloc(0);
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) return undefined;
  const body = Buffer.from(value, 'base64');
  return body.toString('base64') === value ? body : undefined;
}

/**
 * Locates the built SPA next to the package that owns this module.
 *
 * Walking to the manifest rather than counting `..` segments keeps this correct
 * whether the code runs from `src` in development or from the unbundled `dist`
 * tree, whose depth is a build detail.
 */
function packagedDirectory(name: 'web' | 'pwa'): string {
  const configuredRoot = process.env[WEB_PACKAGE_ROOT_ENV];
  if (configuredRoot !== undefined && configuredRoot !== '') return path.join(configuredRoot, 'dist', name);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'dist', name);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('doompi-web could not locate its own package root.');
    dir = parent;
  }
}

function packagedAssetsDir(): string {
  return packagedDirectory('web');
}

function packagedPwaDir(): string {
  return packagedDirectory('pwa');
}

export { packagedVersion };

/** The assets to serve, with explicit overrides ahead of this hub's registration. */
function resolveAssetsDir(
  explicit: string | undefined,
  composition: { webDirectory: string | null } | undefined,
  notice: (message: string) => void,
): string {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env[WEB_DIST_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const synced = composition?.webDirectory;
  if (synced !== undefined && synced !== null && fs.existsSync(path.join(synced, INDEX_FILE))) {
    notice(`serving the synced cockpit bundle from ${synced}`);
    return synced;
  }
  return packagedAssetsDir();
}

function readAsset(filePath: string): Buffer | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function singleByteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || size === 0) return undefined;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** A compact rail name while Pi starts and reports the thread's persisted name. */
function resumedSessionName(info: { name?: string; firstMessage: string }, cwd: string): string {
  const firstLine = info.firstMessage.split('\n', 1)[0]?.trim();
  return (info.name?.trim() || firstLine || path.basename(cwd) || 'untitled').slice(0, 80);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HubServerFacet = DoomServerFacet | LoadedServerFacet;

export async function loadHubApis(
  registration: SyncRegistration | undefined,
  directoryOverride: string | undefined,
  notice: (message: string) => void,
  composition?: NonNullable<SessionRecord['serverComposition']>,
): Promise<{ apis: DoomApi[]; facets: HubServerFacet[]; key?: string }> {
  const source =
    composition === undefined
      ? resolveServerBundleSource({ registration, directoryOverride })
      : {
          kind: 'descriptor' as const,
          directory: composition.apiDirectory,
          generation: composition.generation,
          fingerprint: composition.fingerprint,
        };
  if (source.kind === 'empty') return { apis: [], facets: [] };
  if (source.kind === 'legacy')
    return {
      apis: await loadPackageApis('hub', { apiDirectory: source.directory, env: {}, onNotice: notice }),
      facets: await loadServerFacets('hub', { apiDirectory: source.directory, env: {}, onNotice: notice }),
      key: source.directory,
    };
  let selection = composition;
  if (selection === undefined) {
    if (registration === undefined) throw new Error('A descriptor override requires an admitted repository selection');
    const state = readSyncState(registration.root);
    if (state === undefined) throw new Error(`No sync state is available for ${registration.root}`);
    const config = loadMajorModesConfig(registration.root);
    const harness = readHarnessState(state.env);
    const layers = resolveLayers(config, state.selection.majorMode);
    selection = {
      root: registration.root,
      apiDirectory: source.directory,
      generation: source.generation,
      fingerprint: source.fingerprint,
      majorMode: state.selection.majorMode,
      activeLayers: harness.hooks ? layers : layers.filter((layer) => layerHookGroups(config, [layer]).length === 0),
    };
  }
  const bundle = await loadServerBundle('hub', { ...source, ...selection, onNotice: notice });
  return { apis: [], facets: [...bundle.facets], key: sessionBundleKey(selection) };
}

/** One page's hold on one thread; a session id never contains a newline, so the pair cannot collide. */
function threadKey(sessionId: string, threadId: string): string {
  return `${sessionId}\n${threadId}`;
}

function buildHub(
  options: WebServerOptions,
  notice: (message: string) => void,
  plugins: Pick<SessionHubOptions, 'loadChannels' | 'webComposition'>,
  telemetry: DoomTelemetry,
): SessionHub {
  return createSessionHub({
    source: watchRegistry(options.registryDir, notice),
    spawner: createServerSpawner({
      registryDir: options.registryDir,
      command: options.spawnCommand,
      onNotice: notice,
    }),
    readGit: readGitStatus,
    readLineage: (sessionId) => readSessionLineage(options.registryDir, sessionId),
    ...plugins,
    ...(options.computerUse === undefined ? {} : { computerUse: options.computerUse }),
    telemetry,
    onNotice: notice,
  });
}

/** Stable browser identity for an admitted canonical repository root. */
function repositoryId(root: string): string {
  return `repo-${createHash('sha256').update(root).digest('base64url').slice(0, 24)}`;
}

/** Active repositories plus a bounded set seen earlier during this hub process. */
export function createSettingsRepositoryRegistry(hub: SessionHub): {
  list(): SettingsRepository[];
  resolve(repositoryId: string): string | undefined;
} {
  const recent = new Map<string, { repository: SettingsRepository; seenAt: number }>();
  const refresh = (): SettingsRepository[] => {
    for (const [root, entry] of recent) {
      recent.set(root, { ...entry, repository: { ...entry.repository, active: false } });
    }
    for (const record of hub.records()) {
      try {
        const root = fs.realpathSync(findRepositoryRoot(record.cwd));
        recent.set(root, {
          repository: { id: repositoryId(root), path: root, name: path.basename(root) || root, active: true },
          seenAt: Date.now(),
        });
      } catch {
        // A session outside a marked repository is valid, but has no repository settings surface.
      }
    }
    const inactive = [...recent.entries()]
      .filter(([, entry]) => !entry.repository.active)
      .sort((left, right) => right[1].seenAt - left[1].seenAt);
    for (const [root] of inactive.slice(12)) recent.delete(root);
    return [...recent.values()]
      .sort(
        (left, right) =>
          Number(right.repository.active) - Number(left.repository.active) ||
          right.seenAt - left.seenAt ||
          left.repository.path.localeCompare(right.repository.path),
      )
      .map((entry) => entry.repository);
  };
  return {
    list: refresh,
    resolve(repositoryId) {
      return refresh().find((entry) => entry.id === repositoryId)?.path;
    },
  };
}

/**
 * Mounts the hub-scoped package APIs under /api/plugin/<basePath>/.
 *
 * The prefix is stripped before the API sees the request, so a package
 * declares its routes relative to its own mount and never repeats where a host
 * put it. An API that throws answers 500 for its own routes alone; one bad
 * package never takes the cockpit down with it.
 *
 * Each bundle owns a server host of its own. The cockpit serves several
 * composition roots at once and a base path is only unique inside one of them,
 * so one shared mount table would let the first root loaded shadow the rest.
 */
export function mountHubApis(
  app: Hono,
  initialApis: readonly DoomApi[],
  initialFacets: readonly HubServerFacet[],
  notice: (message: string) => void,
  resolveRepository: (repositoryId: string) => string | undefined,
  readRepositorySync: (repositoryId: string) => DoomRepositorySyncView | undefined,
  resolveBundleKey: (sessionId: string) => string | undefined | Promise<string | undefined> = () => 'default',
  initialBundleKey = 'default',
  /** Lends the hub's OAuth redirect to hub APIs that broker third-party sign-in. */
  oauthRedirect?: () => DoomOAuthRedirect | undefined,
): {
  ready: Promise<void>;
  add: (apis: readonly DoomApi[], facets?: readonly HubServerFacet[], bundleKey?: string) => Promise<void>;
  remove: (bundleKey: string) => Promise<void>;
  close: () => Promise<void>;
} {
  const bundles = new Map<string, { host: DoomServerHost; installed?: InstalledServerFacets }>();
  const pending = new Map<string, Promise<void>>();
  let closed = false;
  const apiContext: DoomApiContext = {
    scope: 'hub',
    onNotice: notice,
    resolveRepository,
    readRepositorySync,
    ...(oauthRedirect ? { oauthRedirect } : {}),
  };
  const add = async (
    apis: readonly DoomApi[],
    facets: readonly HubServerFacet[] = [],
    bundleKey = initialBundleKey,
  ): Promise<void> => {
    if (closed) throw new Error('Hub package APIs are closed');
    const previous = pending.get(bundleKey);
    if (previous !== undefined) return previous;
    const installing = Promise.resolve()
      .then(async () => {
        let bundle = bundles.get(bundleKey);
        if (bundle === undefined) {
          bundle = { host: createDoomServerHost({ scope: 'hub', context: apiContext }) };
          bundles.set(bundleKey, bundle);
        }
        try {
          for (const api of apis) bundle.host.registerApi(api);
          if (facets.length > 0 && bundle.installed === undefined) {
            bundle.installed = await installServerFacets({ host: bundle.host, facets, onNotice: notice });
          }
        } catch (error) {
          bundles.delete(bundleKey);
          bundle.host.dispose();
          throw error;
        }
      })
      .finally(() => {
        pending.delete(bundleKey);
      });
    pending.set(bundleKey, installing);
    return installing;
  };
  const remove = async (bundleKey: string): Promise<void> => {
    await pending.get(bundleKey);
    const bundle = bundles.get(bundleKey);
    if (bundle === undefined) return;
    bundles.delete(bundleKey);
    await bundle.installed?.dispose();
    bundle.host.dispose();
  };

  const ready = add(initialApis, initialFacets);
  app.all(`${DOOM_API_ROUTE_PREFIX}/:basePath/*`, async (context, next) => {
    await ready;
    const sessionApi = context.req.query(API_SESSION_QUERY_PARAM);
    const hubSession = context.req.query(DOOM_HUB_API_SESSION_QUERY_PARAM);
    if (sessionApi !== undefined && hubSession !== undefined) {
      return context.json({ error: 'A package API request cannot select both a session API and a hub bundle.' }, 400);
    }
    if (sessionApi !== undefined) return next();
    const bundleKey = hubSession === undefined ? initialBundleKey : await resolveBundleKey(hubSession);
    if (bundleKey === undefined) return context.notFound();
    const basePath = context.req.param('basePath');
    const handler = bundles.get(bundleKey)?.host.handlerFor(basePath);
    if (handler === undefined) return next();
    const mount = `${DOOM_API_ROUTE_PREFIX}/${basePath}`;
    const url = new URL(context.req.url);
    url.pathname = url.pathname.slice(mount.length) || '/';
    url.searchParams.delete(DOOM_HUB_API_SESSION_QUERY_PARAM);
    try {
      return await handler.fetch(new Request(url, context.req.raw));
    } catch (error) {
      notice(`hub API '${basePath}' failed on ${url.pathname} (${describeError(error)})`);
      return context.json({ error: `The '${basePath}' API failed.` }, 500);
    }
  });
  return {
    ready,
    add,
    remove,
    close: async () => {
      closed = true;
      await Promise.allSettled(pending.values());
      for (const bundleKey of Array.from(bundles.keys())) await remove(bundleKey);
    },
  };
}

/**
 * Forwards a package API request carrying ?session= to that session's own
 * server, over the API socket its registry record names.
 *
 * The session servers are where session-scoped data lives, but the browser must
 * not talk to them: their attach tokens stay in this process and the page only
 * ever reaches loopback. So the hub is the one door, and this is the hop behind
 * it. A session that never mounted an API answers 404 with the reason rather
 * than leaving the page waiting.
 */
function mountSessionApiProxy(
  app: Hono,
  hub: SessionHub,
  notice: (message: string) => void,
  telemetry: DoomTelemetry,
  resolveCaller: (context: Context) => DoomApiCaller | undefined,
): void {
  app.all(`${DOOM_API_ROUTE_PREFIX}/*`, async (context) => {
    const sessionId = context.req.query(API_SESSION_QUERY_PARAM);
    if (sessionId === undefined) return context.notFound();
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (summary === undefined) return context.json({ error: `No session ${sessionId}.` }, 404);
    if (summary.apiSocketPath === undefined) {
      return context.json({ error: `Session ${sessionId} serves no package API.` }, 404);
    }
    const url = new URL(context.req.url);
    url.searchParams.delete(API_SESSION_QUERY_PARAM);
    const parent = readTraceContext(context.req.raw.headers);
    try {
      return await telemetry.runInSpan(
        'web.package_proxy',
        { 'operation.name': 'web.package_proxy', 'http.method': context.req.method },
        async (trace) =>
          await proxyToSocket({
            socketPath: summary.apiSocketPath as string,
            path: `${url.pathname}${url.search}`,
            method: context.req.method,
            headers: context.req.raw.headers,
            body: context.req.raw.body,
            caller: resolveCaller(context),
            trace: forwardedTraceContext(trace, parent),
          }),
        parent,
      );
    } catch (error) {
      notice(`session ${sessionId} API is unreachable (${describeError(error)})`);
      return context.json({ error: `Session ${sessionId} is not answering.` }, 502);
    }
  });
}

/**
 * Serves the cockpit and multiplexes every session behind it.
 *
 * Attach tokens stay in this process. The browser authenticates by reaching a
 * loopback port, so a page never holds a credential that would let it talk to
 * a session directly. One page WebSocket carries all sessions: hub frames
 * describe the set, and session traffic travels enveloped by session id.
 */
export async function serveWeb(options: WebServerOptions): Promise<WebServer> {
  const host = options.host ?? '127.0.0.1';
  const notice = options.onNotice ?? ((): void => {});
  const telemetry = createWebTelemetry();
  const store = createRemoteAccessStore({ stateDir: options.remoteStateDir, onNotice: notice });
  const devProxy = createDevProxyStore({ stateDir: store.directory, onNotice: notice });
  const repositoryRoot = (directory: string): string | undefined => {
    try {
      return fs.realpathSync(findRepositoryRoot(directory));
    } catch {
      return undefined;
    }
  };
  const compositionRoot = (directory: string): string => {
    const home = os.homedir();
    const root = resolveDoomConfigurationRoot(directory, home);
    if (root === globalDoomConfigDirectory(home)) return root;
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  };
  const pinnedRoot = options.compositionDir === undefined ? undefined : repositoryRoot(options.compositionDir);
  if (options.compositionDir !== undefined && pinnedRoot === undefined) {
    throw new Error(`Cockpit composition directory is not inside a repository: ${options.compositionDir}`);
  }
  const cockpitRoot = globalDoomConfigDirectory(os.homedir());
  const cockpitSyncGuard = createSyncGuard({ repoRoot: cockpitRoot, onNotice: notice });
  let registerRootHubApis = async (_root: string): Promise<void> => {};
  const rootsUsingGlobalFallback = new Set<string>();
  const readRegistration = (root: string): SyncRegistration | undefined => readSyncRegistration(root);
  const selectedRegistration = (root: string): SyncRegistration | undefined => {
    const selectedRoot = root !== cockpitRoot && rootsUsingGlobalFallback.has(root) ? cockpitRoot : root;
    const registration = readRegistration(selectedRoot);
    return registration ?? (selectedRoot === cockpitRoot ? undefined : readRegistration(cockpitRoot));
  };
  const readyRegistration = (root: string): SyncRegistration | undefined => {
    const registration = selectedRegistration(root);
    if (registration?.webDirectory === null || registration?.webDirectory === undefined) return undefined;
    const bundleRoot = path.dirname(registration.webDirectory);
    const complete =
      fs.existsSync(path.join(registration.webDirectory, INDEX_FILE)) &&
      fs.existsSync(path.join(bundleRoot, 'plugins', 'composition.js')) &&
      fs.existsSync(path.join(bundleRoot, 'plugins', 'manifest.json'));
    return complete ? registration : undefined;
  };

  const ensureRootSynced = async (root: string): Promise<void> => {
    try {
      if (root === cockpitRoot) {
        await cockpitSyncGuard.ensureSynced();
      } else {
        const guard = createSyncGuard({ repoRoot: root, onNotice: notice });
        try {
          await guard.ensureSynced();
        } finally {
          guard.close();
        }
      }
      rootsUsingGlobalFallback.delete(root);
    } catch (error) {
      if (root === cockpitRoot || readyRegistration(cockpitRoot) === undefined) throw error;
      rootsUsingGlobalFallback.add(root);
      notice(`sync failed for ${root}; using the global DoomPi bundle (${describeError(error)})`);
    }
    await registerRootHubApis(root);
  };
  const syncRootAtStartup = async (root: string): Promise<void> => {
    try {
      await ensureRootSynced(root);
    } catch (error) {
      notice(`WARNING: startup sync failed for ${root}; continuing to serve the cockpit (${describeError(error)})`);
    }
  };
  await syncRootAtStartup(cockpitRoot);
  const ensureSessionSynced = async (directory: string): Promise<void> =>
    await ensureRootSynced(compositionRoot(directory));
  const initialRecords = readRegistryRecords(options.registryDir, notice);
  const initialRoots = [
    ...initialRecords.map((record) => compositionRoot(record.cwd)),
    ...(pinnedRoot === undefined ? [] : [compositionRoot(pinnedRoot)]),
  ];
  await Promise.all([...new Set(initialRoots)].map(syncRootAtStartup));

  // The shell is package-owned and stable. Synchronized roots contribute only
  // immutable session plugin compositions and session-local hub channels.
  const served = {
    assetsDir: resolveAssetsDir(options.assetsDir, undefined, notice),
    apiDirectory: undefined,
  };
  const pluginPublication = createPluginBundlePublication(store.directory, notice);
  const recordingArtifacts = createRecordingArtifactStore(
    options.computerUse,
    Date.now,
    randomUUID,
    path.join(options.registryDir, 'computer-use', 'recordings'),
  );
  const hub = buildHub(
    { ...options, ...(recordingArtifacts.binding === undefined ? {} : { computerUse: recordingArtifacts.binding }) },
    notice,
    {
      loadChannels: async (record) => {
        const root = compositionRoot(record.cwd);
        await ensureRootSynced(root);
        const registration = selectedRegistration(root);
        return registration?.webDirectory === null || registration?.webDirectory === undefined
          ? []
          : await loadHubChannels(registration.webDirectory, notice);
      },
      webComposition: (record, channels) => {
        const registration = selectedRegistration(compositionRoot(record.cwd));
        const artifacts =
          registration === undefined ? undefined : resolveSessionWebArtifacts(registration.root, cockpitRoot);
        if (artifacts === undefined) return undefined;
        const published = pluginPublication.publish(artifacts.id, artifacts.pluginsDir);
        if (published === undefined) return undefined;
        const revision = published.signed.manifest.revision;
        const route = `${PLUGIN_BUNDLE_PREFIX}${artifacts.id}/${String(revision)}`;
        return {
          id: artifacts.id,
          revision,
          manifestUrl: `${route}/manifest`,
          rawAssetBaseUrl: `${route}/assets`,
          verifiedAssetBaseUrl: `${VERIFIED_PLUGIN_PREFIX}${artifacts.id}/${String(revision)}`,
          entryPath: artifacts.entryPath,
          stylePaths: artifacts.stylePaths,
          channels: [...channels],
        };
      },
    },
    telemetry,
  );
  // Threads are journals the data channels can name (a subagent run's own
  // session file); the hub tails one only while a page follows it.
  const threads = createThreadJournals({
    resolve: (sessionId, threadId) => hub.threadJournal(sessionId, threadId),
    onNotice: notice,
  });
  /**
   * Every attached page, tagged with the listener it arrived on.
   *
   * The split matters: an approval prompt must reach the host and only the
   * host, because a paired phone that could approve devices would be able to
   * make its own access permanent.
   */
  const pages = new Set<{ post: (frame: object) => void; local: boolean }>();
  const broadcast = (frame: object, localOnly: boolean): void => {
    for (const page of pages) {
      if (localOnly && !page.local) continue;
      page.post(frame);
    }
  };

  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });
  /** Known once the listener binds; until then the guard treats every request as remote. */
  let loopbackPort: number | undefined;
  const pwaDir = packagedPwaDir();
  const publication = createBundlePublication({
    assetsDir: () => served.assetsDir,
    stateDir: store.directory,
    onNotice: notice,
  });
  let livePush: LiveWebPush | undefined;
  reapStaleTunnel(store.directory, notice);
  /**
   * Stands the host's sessions down so the container can take them over.
   *
   * Done here rather than in the launcher because this is where the hub is, and
   * the stop has to happen before the move: a recreated session opens the same
   * working tree, and two agents in one tree would fight over it.
   */
  const handover =
    options.onHandover === undefined
      ? undefined
      : (settings: RemoteAccessSettings): void => {
          const plan = planSessionMigration(
            hub.snapshot().map((session) => ({
              id: session.id,
              cwd: session.cwd,
              ...(session.name === undefined ? {} : { name: session.name }),
            })),
            settings.sandbox.workspaces,
          );
          for (const line of describeStranded(plan.stranded)) notice(line);
          for (const session of plan.migrate) {
            const stopped = hub.stop(session.id);
            if (!stopped.ok) notice(`could not stop ${session.name ?? session.id} before the move: ${stopped.error}`);
          }
          options.onHandover?.({ settings, sessions: plan.migrate });
        };

  const remote = createRemoteAccess({
    store,
    launchTunnel:
      options.remoteAccess?.launchTunnel ??
      createTunnelLauncher({
        stateDir: store.directory,
        ...(options.cloudflaredPath === undefined ? {} : { cloudflaredPath: options.cloudflaredPath }),
        onNotice: notice,
        onExit: (message) => {
          notice(`remote access: ${message}`);
          void remote.disable();
        },
      }),
    // The tunnel gets its own loopback socket. That is the only reliable way to
    // tell its traffic from the host's, since cloudflared connects from
    // 127.0.0.1 and forges nothing a header could reveal.
    bindListener: async () =>
      await new Promise((resolve, reject) => {
        const tunnelServer = serve(
          {
            fetch: app.fetch,
            port: 0,
            hostname: '127.0.0.1',
            serverOptions: {
              maxHeaderSize: TUNNEL_HEADER_BYTES,
              headersTimeout: TUNNEL_HEADERS_TIMEOUT_MS,
              requestTimeout: TUNNEL_REQUEST_TIMEOUT_MS,
            },
          },
          (info) => {
            nodeWs.injectWebSocket(tunnelServer);
            resolve({
              port: info.port,
              close: async () =>
                await new Promise<void>((done) => {
                  (tunnelServer as { closeAllConnections?: () => void }).closeAllConnections?.();
                  tunnelServer.close(() => done());
                }),
            });
          },
        );
        const bounded = tunnelServer as typeof tunnelServer & { maxConnections: number; maxRequestsPerSocket: number };
        bounded.maxConnections = TUNNEL_CONNECTION_LIMIT;
        bounded.maxRequestsPerSocket = TUNNEL_REQUESTS_PER_SOCKET;
        tunnelServer.once('error', reject);
      }),
    bundleTrust: () => publication.trust(),
    onDeviceDropped: (deviceId) => livePush?.remove(deviceId),
    onNotice: notice,
    ...(handover === undefined ? {} : { requestHandover: handover }),
    contained: insideSandbox(process.env),
    broadcastLocal: (frame) => broadcast(frame, true),
    broadcastAll: (frame) => broadcast(frame, false),
    ...(options.remoteAccess?.now === undefined ? {} : { now: options.remoteAccess.now }),
  });
  livePush = createLiveWebPush({
    stateDir: store.directory,
    isConnected: (deviceId) => remote.isDeviceConnected(deviceId),
    onNotice: notice,
  });
  const disconnectLivePush = hub.onEvent((event) => {
    if (event.kind === 'frame' && parseDoomNotificationEntry(event.frame) !== undefined) void livePush?.notify();
  });
  // First route on the app, because Hono composes matching handlers in
  // registration order: a guard added after a terminating handler never runs
  // for that path. It also refuses socket upgrades, which is what closes the
  // cross-site WebSocket hijack that loopback binding never covered.
  const federationStore = createFederationStore(store.directory);
  const federationTransport = options.federation?.enabled
    ? createFederationTransport({
        store: federationStore,
        records: () => hub.records(),
        onNotice: notice,
      })
    : undefined;
  const federationProtocol = federationTransport
    ? createFederationProtocol({
        transport: federationTransport,
        store: federationStore,
        records: () => hub.records(),
        onNotice: notice,
      })
    : undefined;
  const federationDirectory: ReturnType<typeof createFederationDirectory> | undefined = federationTransport
    ? createFederationDirectory({
        store: federationStore,
        onNotice: notice,
        onChanged: () =>
          broadcast(
            {
              type: SESSIONS_SNAPSHOT_TYPE,
              sessions: [...hub.snapshot(), ...(federationDirectory?.summaries() ?? [])],
            },
            false,
          ),
      })
    : undefined;
  const guard = createRemoteGuard({
    loopbackPort: () => loopbackPort,
    tunnelPolicy: () => remote.tunnelPolicy(),
    authorize: (context) => remote.authorize(getCookie(context, DEVICE_COOKIE, 'host')),
    trustedDevice: (context) => (context.env as SealedRequestBindings | undefined)?.sealedDeviceId,
    channelReady: (deviceId, scope) => remote.channelFor(deviceId, scope) !== undefined,
    federationRoute: (context) =>
      federationTransport !== undefined &&
      ((context.req.method === 'POST' && context.req.path === FEDERATION_TRANSPORT_ROUTE) ||
        (context.req.method === 'GET' &&
          context.req.path === FEDERATION_PROTOCOL_ROUTE &&
          context.req.header('upgrade')?.toLowerCase() === 'websocket')),
    stepUp: {
      required: (action) => remote.stepUpRequired(action),
      verify: async (context, action, assertion) => {
        if (typeof assertion !== 'object' || assertion === null) return false;
        const ceremonyId = (assertion as { ceremonyId?: unknown }).ceremonyId;
        const response = (assertion as { response?: unknown }).response;
        if (typeof ceremonyId !== 'string') return false;
        const trusted = (context.env as SealedRequestBindings | undefined)?.sealedDeviceId;
        const deviceId = trusted ?? remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
        const caller = deviceId === undefined ? 'local' : `device:${deviceId}`;
        return await remote.passkeys().finishStepUp(ceremonyId, caller, action, response);
      },
    },
    extraOrigins: allowedOriginsFromEnv(process.env[ALLOW_ORIGIN_ENV]),
  });
  app.use('*', guard.middleware);
  app.use('*', async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    if (pathname === REMOTE_HTTP_ROUTE) return next();
    const operation = requestOperation(pathname);
    if (operation === undefined) return next();
    const started = performance.now();
    return await telemetry.runInSpan(
      operation,
      { 'operation.name': operation, 'http.method': context.req.method },
      async () => {
        await next();
        await telemetry.recordEvent('web.api.request', {
          'operation.name': operation,
          'http.method': context.req.method,
          'http.status_code': context.res.status,
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
        });
      },
      readTraceContext(context.req.raw.headers),
    );
  });
  // Reject a declared oversized body before any public route reads it. Chunked
  // bodies are bounded by the route-specific or downstream streaming limiter.
  app.use('*', async (context, next) => {
    if (guard.listenerOf(context) === 'local') return next();
    const declared = Number(context.req.header('content-length'));
    if (Number.isFinite(declared) && declared > TUNNEL_BODY_BYTES) {
      return context.json({ error: 'The tunnel request body is too large.' }, 413);
    }
    return next();
  });
  registerRemoteRoutes(app, { remote, listenerOf: (context) => guard.listenerOf(context) });
  registerDevProxyRoutes(app, {
    store: devProxy,
    listenerOf: (context) => guard.listenerOf(context),
    // Read at call time rather than captured: the tunnel port only exists while
    // remote access is on, and a target validated against a stale list could
    // end up aimed at the cockpit itself.
    reservedPorts: () => [loopbackPort, remote.tunnelPort(), options.port],
    upgradeWebSocket: nodeWs.upgradeWebSocket,
    onNotice: notice,
  });
  const tunnelBodyLimit = bodyLimit({
    maxSize: TUNNEL_BODY_BYTES,
    onError: (context) => context.json({ error: 'The tunnel request body is too large.' }, 413),
  });
  app.use('*', async (context, next) => {
    if (guard.listenerOf(context) === 'local') return next();
    return await tunnelBodyLimit(context, next);
  });
  const browserTelemetryBodyLimit = bodyLimit({
    maxSize: BROWSER_TELEMETRY_BODY_BYTES,
    onError: (context) => context.json({ error: 'The telemetry batch is too large.' }, 413),
  });
  const acceptBrowserTelemetryRequest = createBrowserTelemetryRateLimit();
  app.post(WEB_TELEMETRY_ROUTE, browserTelemetryBodyLimit, async (context) => {
    if (!acceptBrowserTelemetryRequest()) return context.json({ error: 'Too many telemetry batches.' }, 429);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The telemetry batch must be JSON.' }, 400);
    }
    const events = parseBrowserTelemetryBatch(body);
    if (events === undefined) return context.json({ error: 'The telemetry batch is invalid.' }, 400);
    for (const event of events) {
      if (isBrowserErrorEvent(event)) {
        // The message and stack ride the exception, not the attributes:
        // sanitisation drops those keys, and rightly so for everything that is
        // not an error the reader asked to see.
        await telemetry.recordError(
          BROWSER_ERROR_EVENT,
          createBrowserError(event),
          {
            'browser.source': event.source,
            ...(event.session_id === undefined ? {} : { 'session.id': event.session_id }),
            'failure.kind': 'browser',
          },
          { includeException: true },
        );
        continue;
      }
      await telemetry.recordEvent(event.name, {
        ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
        ...(event.count === undefined ? {} : { count: event.count }),
      });
    }
    return context.body(null, 204);
  });
  app.post(REMOTE_HTTP_ROUTE, async (context) => {
    const deviceId = remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    if (deviceId === undefined) return context.json({ error: 'This device is not paired.' }, 401);
    const channel = remote.channelFor(deviceId, 'http');
    if (channel === undefined) return context.json({ error: 'This device has no sealed HTTP channel.' }, 401);

    let envelope: unknown;
    try {
      envelope = await context.req.json();
    } catch {
      return context.json({ error: 'The sealed request envelope was malformed.' }, 400);
    }
    const opened = channel.open(envelope);
    if (!opened.ok) return context.json({ error: `The sealed request was refused: ${opened.failure}.` }, 400);

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(opened.plaintext));
    } catch {
      return context.json({ error: 'The sealed HTTP request was malformed.' }, 400);
    }
    const request = parseSealedHttpRequest(decoded);
    const headers = request === undefined ? undefined : sealedRequestHeaders(request, context);
    const body = request === undefined ? undefined : decodeSealedHttpBody(request.body);
    if (request === undefined || headers === undefined || body === undefined) {
      return context.json({ error: 'The sealed HTTP request was invalid.' }, 400);
    }

    const target = new URL(request.target, new URL(context.req.url).origin);
    const innerResponse = await app.request(
      target,
      {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: Uint8Array.from(body).buffer }),
      },
      { ...(context.env as SealedRequestBindings), sealedDeviceId: deviceId },
    );
    const responseBody = Buffer.from(await innerResponse.arrayBuffer());
    const sealed = channel.seal(
      new TextEncoder().encode(
        JSON.stringify({
          v: SEALED_HTTP_VERSION,
          status: innerResponse.status,
          headers: Array.from(innerResponse.headers.entries()),
          body: responseBody.toString('base64'),
        }),
      ),
    );
    if (!sealed.ok) return context.json({ error: `The sealed response failed: ${sealed.failure}.` }, 503);
    return context.json(sealed.envelope);
  });
  const pushBodyLimit = bodyLimit({
    maxSize: 8 * 1024,
    onError: (context) => context.json({ error: 'The Push subscription is too large.' }, 413),
  });
  const pushDevice = (context: Context): string | undefined =>
    (context.env as SealedRequestBindings | undefined)?.sealedDeviceId;
  app.get(REMOTE_PUSH_KEY_ROUTE, (context) => {
    if (pushDevice(context) === undefined) return context.json({ error: 'A sealed paired device is required.' }, 401);
    return context.json({ publicKey: livePush?.publicKey() }, 200, { 'Cache-Control': 'no-store' });
  });
  app.post(REMOTE_PUSH_ROUTE, pushBodyLimit, async (context) => {
    const deviceId = pushDevice(context);
    if (deviceId === undefined) return context.json({ error: 'A sealed paired device is required.' }, 401);
    let subscription: unknown;
    try {
      subscription = await context.req.json();
    } catch {
      return context.json({ error: 'The Push subscription must be JSON.' }, 400);
    }
    if (livePush?.subscribe(deviceId, subscription) !== true) {
      return context.json({ error: 'The Push subscription is invalid.' }, 400);
    }
    return context.body(null, 204);
  });
  app.delete(REMOTE_PUSH_ROUTE, (context) => {
    const deviceId = pushDevice(context);
    if (deviceId === undefined) return context.json({ error: 'A sealed paired device is required.' }, 401);
    livePush?.remove(deviceId);
    return context.body(null, 204);
  });
  // Every running session already serves Pi's protocol; the hub composes them
  // into one server so a browser sees a single endpoint with many sessions.
  // Remote clients get a distinct protocol service that can attach to existing
  // sessions but cannot bypass HTTP step-up by creating one directly.
  const protocolConnections = new Set<() => void>();
  // Provider credentials belong to the machine, not to a session: the hub
  // keeps one Pi runtime over the shared auth.json and signs in for all.
  const providerAuth = createProviderAuth({ runtime: options.authRuntime, onNotice: notice });
  registerAuthRoutes(app, providerAuth, (context) => guard.listenerOf(context));
  // One redirect surface for both localities. A package brokering OAuth cannot
  // use a loopback redirect when the browser is on another machine, and the
  // hub already serves a listener that browser can reach.
  const oauthRedirects = createOAuthRedirectRegistry(MCP_OAUTH_CALLBACK_ROUTE);
  registerOAuthRedirectRoutes(app, oauthRedirects);
  const oauthRedirect = (): DoomOAuthRedirect | undefined => {
    // Read per call: a quick tunnel reconnects on a new hostname, and a stale
    // origin would register a redirect that no longer resolves.
    const origin =
      remote.publicOrigin() ?? (loopbackPort === undefined ? undefined : `http://127.0.0.1:${loopbackPort}`);
    return origin === undefined ? undefined : oauthRedirects.surface(origin);
  };
  // Settings read and write the machine's Doom config. Session working
  // directories are normalized to their nearest repository marker before the
  // picker or a package API can address them. The bounded registry keeps recent
  // roots available after their last session closes without trusting browser paths.
  const repositoryRegistry = createSettingsRepositoryRegistry(hub);
  const repositories = (): SettingsRepository[] => repositoryRegistry.list();
  const resolveRepository = (repositoryId: string): string | undefined => repositoryRegistry.resolve(repositoryId);
  const readRepositorySync = (repositoryId: string): DoomRepositorySyncView | undefined => {
    const root = resolveRepository(repositoryId);
    if (root === undefined) return undefined;
    const drift = readSyncDrift({ repoRoot: root });
    let state: SyncState | undefined;
    try {
      state = readSyncRegistration(root) ? readSyncState(root) : undefined;
    } catch {
      state = undefined;
    }
    return {
      fresh: drift.fresh,
      reasons: [...drift.reasons],
      ...(state === undefined ? {} : { mcpProjection: state.fileState.mcpProjection }),
    };
  };
  registerSettingsRoutes(app, {
    repositories,
    models: () => providerAuth.listModels(),
  });
  // Package APIs, mounted before the SPA fallback so their routes are reachable
  // and everything else still falls through to the bundle. Hub-scoped ones run
  // here; session-scoped ones live in each session's own server and are proxied.
  const apiDirectory = served.apiDirectory;
  const overriddenApiDirectory = process.env[PACKAGE_API_DIR_ENV];
  const apiDirectoryOverride =
    apiDirectory ??
    (overriddenApiDirectory === undefined || overriddenApiDirectory === '' ? undefined : overriddenApiDirectory);
  const defaultRegistration = readRegistration(cockpitRoot);
  const sessionApiBundles = new Map<string, string>();
  const defaultBundle = await loadHubApis(defaultRegistration, apiDirectoryOverride, notice);
  const defaultApiBundleKey = defaultBundle.key ?? 'default';
  const pluginApis = mountHubApis(
    app,
    defaultBundle.apis,
    defaultBundle.facets,
    notice,
    resolveRepository,
    readRepositorySync,
    async (sessionId) => {
      const record = hub.records().find((candidate) => candidate.id === sessionId);
      if (record === undefined) return undefined;
      const root = compositionRoot(record.cwd);
      const registration = readRegistration(root);
      if (registration === undefined) return undefined;
      const composition = sessionBundleSelection(record, registration);
      if (composition === undefined) {
        // Old hosts do not prove a selection for a new candidate descriptor.
        return registration.serverBundle === undefined ? registeredApiBundles.get(root) : undefined;
      }
      const loaded = await loadHubApis(registration, undefined, notice, composition);
      const key = loaded.key!;
      await pluginApis.add(loaded.apis, loaded.facets, key);
      const previous = sessionApiBundles.get(sessionId);
      sessionApiBundles.set(sessionId, key);
      if (previous !== key) await removeUnusedApiBundle(previous);
      return key;
    },
    defaultApiBundleKey,
    oauthRedirect,
  );
  await pluginApis.ready;
  const registeredApiBundles = new Map<string, string>();
  const apiBundleInUse = (bundleKey: string): boolean =>
    bundleKey === defaultApiBundleKey ||
    [...registeredApiBundles.values(), ...sessionApiBundles.values()].includes(bundleKey);
  const removeUnusedApiBundle = async (bundleKey: string | undefined): Promise<void> => {
    if (bundleKey !== undefined && !apiBundleInUse(bundleKey)) await pluginApis.remove(bundleKey);
  };
  registerRootHubApis = async (root: string): Promise<void> => {
    const previousBundleKey = registeredApiBundles.get(root);
    const registration = readRegistration(root);
    if (registration === undefined || (root !== cockpitRoot && registration.serverBundle !== undefined)) {
      registeredApiBundles.delete(root);
      await removeUnusedApiBundle(previousBundleKey);
      return;
    }
    const loaded = await loadHubApis(registration, apiDirectoryOverride, notice);
    const bundleKey = loaded.key ?? defaultApiBundleKey;
    if (bundleKey !== defaultApiBundleKey) await pluginApis.add(loaded.apis, loaded.facets, bundleKey);
    registeredApiBundles.set(root, bundleKey);
    if (previousBundleKey !== bundleKey) await removeUnusedApiBundle(previousBundleKey);
  };
  const sessionApiRoots = new Map(hub.snapshot().map((session) => [session.id, compositionRoot(session.cwd)]));
  const disconnectApiBundleCleanup = hub.onEvent((event) => {
    if (event.kind === 'upsert') {
      sessionApiRoots.set(event.session.id, compositionRoot(event.session.cwd));
      return;
    }
    if (event.kind !== 'removed') return;
    const sessionBundle = sessionApiBundles.get(event.sessionId);
    sessionApiBundles.delete(event.sessionId);
    void removeUnusedApiBundle(sessionBundle);
    const root = sessionApiRoots.get(event.sessionId);
    sessionApiRoots.delete(event.sessionId);
    if (root === undefined || root === cockpitRoot || [...sessionApiRoots.values()].includes(root)) return;
    const bundleKey = registeredApiBundles.get(root);
    registeredApiBundles.delete(root);
    void removeUnusedApiBundle(bundleKey);
  });
  await Promise.all([...new Set([cockpitRoot, ...initialRoots])].map(registerRootHubApis));
  mountSessionApiProxy(app, hub, notice, telemetry, (context) => guard.callerOf(context));

  app.get('/api/health', (context) =>
    context.json({
      ok: true,
      role: HUB_ROLE,
      protocol: HUB_PROTOCOL_VERSION,
      sessions: hub.snapshot().length,
      pid: process.pid,
      version: packagedVersion(),
    }),
  );

  registerFederationRoutes(app, {
    store: federationStore,
    records: () => hub.records(),
    transport: federationTransport,
    directory: federationDirectory,
    isLocal: (context) => guard.callerOf(context)?.locality === 'local',
    onNotice: notice,
  });

  app.post(SESSIONS_API_ROUTE, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The request body must be JSON.' }, 400);
    }
    if (!isRecord(body) || typeof body.cwd !== 'string' || body.cwd === '') {
      return context.json({ error: 'A cwd string is required.' }, 400);
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(body.cwd);
    } catch {
      return context.json({ error: `No such directory: ${body.cwd}` }, 400);
    }
    if (!path.isAbsolute(body.cwd) || !stats.isDirectory()) {
      return context.json(
        { error: `The working directory must be an absolute path to a directory, received "${body.cwd}".` },
        400,
      );
    }
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined;
    // Lineage is accepted from the caller but never invented here. A parent id
    // naming a session that has since gone is harmless: the rail falls back to
    // drawing the child at the top level.
    const parentSessionId =
      typeof body.parentSessionId === 'string' && body.parentSessionId !== '' ? body.parentSessionId : undefined;
    const provenance = typeof body.provenance === 'string' && body.provenance !== '' ? body.provenance : undefined;
    await ensureSessionSynced(body.cwd);
    const outcome = await hub.create({
      cwd: body.cwd,
      name,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(provenance === undefined ? {} : { provenance }),
      trace: readTraceContext(context.req.raw.headers),
    });
    if (outcome.ok) return context.json({ sessionId: outcome.sessionId }, 201);
    return context.json({ error: outcome.error }, outcome.code === 'invalid_request' ? 400 : 502);
  });

  // A running server reads the composition once: its extensions when the agent
  // starts, its package API routes when the process does. So a rebuild reaches
  // an existing session only by replacing the process, and the sync has to
  // finish before the replacement starts or it reads the same stale artifacts.
  app.post(`${SESSIONS_API_ROUTE}/:sessionId/restart`, async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (summary !== undefined) await ensureSessionSynced(summary.cwd);
    const outcome = await hub.restart(sessionId, readTraceContext(context.req.raw.headers));
    if (outcome.ok) return context.json({ sessionId: outcome.sessionId }, 202);
    return context.json({ error: outcome.error }, outcome.code === 'invalid_request' ? 404 : 502);
  });

  app.get(`${SESSIONS_API_ROUTE}/:sessionId/history`, async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (!summary) return context.json({ error: 'Unknown session.' }, 404);
    const sessions = await SessionManager.list(summary.cwd);
    return context.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        ...(session.name === undefined ? {} : { name: session.name }),
        firstMessage: session.firstMessage,
        createdAt: session.created.toISOString(),
        updatedAt: session.modified.toISOString(),
        messageCount: session.messageCount,
      })),
    });
  });

  app.post(`${SESSIONS_API_ROUTE}/:sessionId/resume`, async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (!summary) return context.json({ error: 'Unknown session.' }, 404);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The request body must be JSON.' }, 400);
    }
    if (!isRecord(body) || typeof body.targetSessionId !== 'string' || body.targetSessionId === '') {
      return context.json({ error: 'A targetSessionId string is required.' }, 400);
    }
    const sessions = await SessionManager.list(summary.cwd);
    const target = sessions.find((session) => session.id === body.targetSessionId);
    if (!target) return context.json({ error: 'That Pi thread does not belong to this workspace.' }, 404);
    await ensureSessionSynced(summary.cwd);
    const outcome = await hub.resume(
      sessionId,
      { sessionId: target.id, name: resumedSessionName(target, summary.cwd) },
      readTraceContext(context.req.raw.headers),
    );
    if (outcome.ok) return context.json({ sessionId: outcome.sessionId }, 202);
    return context.json({ error: outcome.error }, outcome.code === 'invalid_request' ? 409 : 502);
  });
  app.delete(`${SESSIONS_API_ROUTE}/:sessionId`, (context) => {
    const sessionId = context.req.param('sessionId');
    const outcome = hub.stop(sessionId);
    if (outcome.ok) return context.json({ sessionId }, 202);
    return context.json(
      { error: outcome.error },
      outcome.code === 'unknown' ? 404 : outcome.code === 'self' ? 409 : 502,
    );
  });

  // File completion for the composer's @ references: bounded, cwd-scoped,
  // and only for sessions the hub actually manages.
  app.get('/api/sessions/:sessionId/files', async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (!summary) return context.json({ error: 'Unknown session.' }, 404);
    const query = context.req.query('q') ?? '';
    const files = await listSessionFiles(summary.cwd, query, 20);
    return context.json({ files });
  });

  /**
   * The subtree directory suggestions may name, or undefined for all of them.
   *
   * A paired device can ask this route, and answering from the whole home
   * directory hands it a map of the machine: every project, every client name,
   * every checkout. So a request arriving on the tunnel is pinned to the
   * directory the cockpit was started from, which is the one the person running
   * it already chose.
   *
   * Only that request. The person at this keyboard already has a shell, so
   * pinning them would cost the picker its usefulness and buy nothing. A
   * contained cockpit needs none of it either, because its mounts are the
   * boundary and nothing outside them is visible to it at all.
   */
  const browseRoot = (context: Context): string | undefined => {
    if (guard.listenerOf(context) === 'local' || insideSandbox(process.env)) return undefined;
    return options.browseRoot ?? process.cwd();
  };

  // Directory suggestions for the new-session picker: the children of the
  // typed parent while a path is being drilled into, and a ranked search of
  // the home directory for anything else, so a name or a path remembered from
  // another machine still finds the folder.
  app.get(DIRECTORIES_API_ROUTE, async (context) => {
    const root = browseRoot(context);
    const directories = await suggestDirectories(context.req.query('q') ?? '', {
      limit: DIRECTORY_SUGGESTION_LIMIT,
      ...(root === undefined ? {} : { root }),
    });
    return context.json({ directories });
  });

  app.on(['GET', 'HEAD'], '/api/sessions/:sessionId/computer-use/artifacts/:artifactId', (context) => {
    if (
      guard.listenerOf(context) !== 'local' ||
      (context.env as SealedRequestBindings | undefined)?.sealedDeviceId !== undefined
    ) {
      return context.json({ error: 'Recording playback is available only on this machine.' }, 403);
    }
    const sessionId = context.req.param('sessionId');
    if (!hub.snapshot().some((candidate) => candidate.id === sessionId)) {
      return context.json({ error: 'Unknown session.' }, 404);
    }
    return recordingArtifacts.response(
      sessionId,
      context.req.param('artifactId'),
      context.req.header('range'),
      context.req.query('download') === '1',
      context.req.method === 'HEAD',
    );
  });

  // The timeline's @file previews and guarded host saves: one cwd-contained file, capped in size.
  app.get(SESSION_FILE_ROUTE, async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (!summary) return context.json({ error: 'Unknown session.' }, 404);
    const relativePath = context.req.query('path') ?? '';
    const file = await readSessionFile(summary.cwd, relativePath, MAX_SESSION_FILE_BYTES);
    if (file.status === 'forbidden') return context.json({ error: 'The path leaves the session directory.' }, 403);
    if (file.status === 'not-found') return context.json({ error: 'No such file.' }, 404);
    if (file.status === 'too-large') return context.json({ error: 'The file is too large to preview.' }, 413);

    const headers = {
      ...sessionFileHeaders(relativePath),
      [SESSION_FILE_SHA256_HEADER]: file.sha256,
      'Accept-Ranges': 'bytes',
    };
    const requestedRange = context.req.header('range');
    if (requestedRange === undefined) return context.body(new Uint8Array(file.body), 200, headers);
    const range = singleByteRange(requestedRange, file.body.byteLength);
    if (range === undefined) {
      return context.body(null, 416, { ...headers, 'Content-Range': `bytes */${String(file.body.byteLength)}` });
    }
    const body = file.body.subarray(range.start, range.end + 1);
    return context.body(new Uint8Array(body), 206, {
      ...headers,
      'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(file.body.byteLength)}`,
      'Content-Length': String(body.byteLength),
    });
  });

  const sessionFileBodyLimit = bodyLimit({
    maxSize: MAX_SESSION_FILE_BYTES,
    onError: (context) => context.json({ error: 'The file is too large to save.' }, 413),
  });
  app.put(SESSION_FILE_ROUTE, sessionFileBodyLimit, async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (!summary) return context.json({ error: 'Unknown session.' }, 404);
    if (hub.planSaveState(sessionId) !== 'allowed') {
      return context.json({ error: 'Host saves are locked until Plan is authoritatively inactive.' }, 423);
    }
    const expectedSha256 = context.req.header(SESSION_FILE_EXPECTED_SHA256_HEADER);
    if (expectedSha256 === undefined || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      return context.json(
        { error: `A lowercase SHA-256 ${SESSION_FILE_EXPECTED_SHA256_HEADER} header is required.` },
        400,
      );
    }
    const body = Buffer.from(await context.req.arrayBuffer());
    const result = await writeSessionFile(
      summary.cwd,
      context.req.query('path') ?? '',
      body,
      expectedSha256,
      MAX_SESSION_FILE_BYTES,
      () => hub.planSaveState(sessionId) === 'allowed',
    );
    if (result.status === 'ok') {
      return context.body(null, 204, { [SESSION_FILE_SHA256_HEADER]: result.sha256 });
    }
    if (result.status === 'forbidden') return context.json({ error: 'The path leaves the session directory.' }, 403);
    if (result.status === 'not-found') return context.json({ error: 'No such file.' }, 404);
    if (result.status === 'too-large') return context.json({ error: 'The file is too large to save.' }, 413);
    if (result.status === 'locked') {
      return context.json({ error: 'Host saves are locked until Plan is authoritatively inactive.' }, 423);
    }
    return context.json({ error: 'The file changed after it was read.' }, 409);
  });

  const hubEvents = (context: Context, protocol = false): WSEvents => {
    const local = guard.listenerOf(context) === 'local';
    // Resolved once at upgrade: the device is fixed for the socket's life, and
    // looking it up per frame would bump last-seen on every keystroke.
    const deviceId = local ? undefined : remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    const channel = deviceId === undefined ? undefined : remote.channelFor(deviceId, 'session');
    const subscriptions = new Set<string>();
    const connectionId = randomUUID();
    /** The threads this page follows; one socket may follow several of one session. */
    const threadSubscriptions = new Map<string, { sessionId: string; threadId: string }>();
    let disconnect: (() => void) | undefined;
    let disconnectThreads: (() => void) | undefined;
    /** Held on the socket, not inside onOpen, so close can withdraw it. */
    let registered: { post: (frame: object) => void; local: boolean } | undefined;
    /** Withdraws this socket from the remote registry, so switch-off can close it. */
    let untrack: (() => void) | undefined;
    /** Lets go of every followed thread, or only a departed session's. */
    const releaseThreads = (sessionId?: string): void => {
      for (const [key, held] of threadSubscriptions) {
        if (sessionId !== undefined && held.sessionId !== sessionId) continue;
        threadSubscriptions.delete(key);
        threads.unsubscribe(held.sessionId, held.threadId);
      }
    };
    return {
      onOpen(_event, ws) {
        if (!local && channel === undefined && !protocol) {
          ws.close(1008, 'sealed session channel required');
          return;
        }
        const post = (frame: SessionFrame | object): void => {
          const text = JSON.stringify(frame);
          let outgoing = text;
          if (!local && !protocol) {
            if (channel === undefined) return;
            const sealed = channel.seal(new TextEncoder().encode(text));
            if (!sealed.ok) {
              ws.close(1008, 'sealed session channel failed');
              return;
            }
            outgoing = JSON.stringify(sealed.envelope);
          }
          try {
            ws.send(outgoing);
          } catch {
            // The browser went away mid-write; onClose tears the socket down.
          }
        };
        registered = { post, local };
        pages.add(registered);
        // A socket that has upgraded has left the HTTP server's connection
        // tracking, so closing the tunnel listener does not reach it.
        // Without this a paired phone keeps driving the agent after remote
        // access is switched off.
        if (deviceId !== undefined) untrack = remote.trackSocket(deviceId, (code, reason) => ws.close(code, reason));
        post(hubHello(hub.channelTypes()));
        post({
          type: SESSIONS_SNAPSHOT_TYPE,
          sessions: [...hub.snapshot(), ...(federationDirectory?.summaries() ?? [])],
        });
        if (federationDirectory)
          void federationDirectory.refresh().catch((error: unknown) => notice(`peer discovery: ${String(error)}`));
        disconnect = hub.onEvent((event) => {
          if (event.kind === 'upsert') post({ type: SESSION_UPSERT_TYPE, session: event.session });
          else if (event.kind === 'removed') {
            subscriptions.delete(event.sessionId);
            releaseThreads(event.sessionId);
            post({ type: SESSION_REMOVED_TYPE, sessionId: event.sessionId });
          } else if (event.kind === 'channel') {
            if (
              event.connectionId === connectionId ||
              (event.connectionId === undefined && subscriptions.has(event.sessionId))
            ) {
              post({ type: event.frameType, sessionId: event.sessionId, payload: event.payload });
            }
          } else {
            const notification = parseDoomNotificationEntry(event.frame);
            if (notification !== undefined || subscriptions.has(event.sessionId)) {
              post(sessionFrameEnvelope(event.sessionId, event.frame));
            }
          }
        });
        disconnectThreads = threads.onFrame((event) => {
          if (threadSubscriptions.has(threadKey(event.sessionId, event.threadId))) {
            post(threadFrameEnvelope(event.sessionId, event.threadId, event.frame));
          }
        });
        notice('browser attached');
      },
      onMessage(event) {
        if (typeof event.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!local && !protocol) {
          if (channel === undefined) return;
          const opened = channel.open(parsed);
          // A frame that will not open was altered or replayed. Dropping it
          // is the only safe answer; there is no plaintext to fall back to.
          if (!opened.ok) return;
          try {
            parsed = JSON.parse(new TextDecoder().decode(opened.plaintext));
          } catch {
            return;
          }
        }
        if (!isRecord(parsed) || typeof parsed.sessionId !== 'string') return;
        const sessionId = parsed.sessionId;
        if (
          typeof parsed.type === 'string' &&
          hub.channelTypes().includes(parsed.type) &&
          (subscriptions.has(sessionId) || hub.channelReceivesWithoutSubscription(sessionId, parsed.type))
        ) {
          hub.receiveChannel(sessionId, parsed.type, parsed.payload, connectionId);
          return;
        }
        if (parsed.type === SUBSCRIBE_TYPE) {
          const backlog = hub.backlog(sessionId);
          if (!backlog) return; // Unknown session; the snapshot said otherwise.
          subscriptions.add(sessionId);
          if (!protocol) registered?.post(backlog);
          for (const frame of hub.channelFrames(sessionId)) registered?.post(frame);
          return;
        }
        if (parsed.type === UNSUBSCRIBE_TYPE) {
          subscriptions.delete(sessionId);
          return;
        }
        if (parsed.type === HISTORY_REQUEST_TYPE) {
          // Older transcript, on demand. The hub kept what the attach path
          // was too small to publish, so scrolling back reads from memory
          // rather than asking the session to re-read its journal.
          const page = hub.history(sessionId, {
            ...(typeof parsed.before === 'string' ? { before: parsed.before } : {}),
            ...(typeof parsed.limit === 'number' ? { limit: parsed.limit } : {}),
          });
          if (!page) return;
          registered?.post(page);
          return;
        }
        if (parsed.type === SUBSCRIBE_THREAD_TYPE || parsed.type === UNSUBSCRIBE_THREAD_TYPE) {
          if (typeof parsed.threadId !== 'string') return;
          const threadId = parsed.threadId;
          const key = threadKey(sessionId, threadId);
          if (parsed.type === UNSUBSCRIBE_THREAD_TYPE) {
            if (threadSubscriptions.delete(key)) threads.unsubscribe(sessionId, threadId);
            return;
          }
          // Register even when the hub does not know the session yet. The tailer resolves
          // the journal path lazily on every tick, so the subscription self-heals once the
          // session appears. Refusing here would drop the request in silence, and the page
          // only sends it again on a fresh socket.
          if (threadSubscriptions.has(key)) return;
          threadSubscriptions.set(key, { sessionId, threadId });
          registered?.post(threadBacklog(sessionId, threadId, threads.subscribe(sessionId, threadId)));
          return;
        }
        if (!protocol && parsed.type === SESSION_COMMAND_TYPE && isRecord(parsed.frame)) {
          // The hub owns the handshake; a page must not be able to replay it.
          if (parsed.frame.type === ATTACH_TYPE) return;
          hub.command(sessionId, parsed.frame);
        }
      },
      onClose() {
        hub.disconnectChannels(connectionId);
        if (registered) pages.delete(registered);
        registered = undefined;
        untrack?.();
        untrack = undefined;
        disconnect?.();
        disconnect = undefined;
        disconnectThreads?.();
        disconnectThreads = undefined;
        subscriptions.clear();
        releaseThreads();
        notice('browser detached');
      },
    };
  };
  // Kept for explicit compatibility clients; the cockpit no longer opens this socket.
  app.get(
    SESSION_SOCKET_ROUTE,
    nodeWs.upgradeWebSocket((context) => hubEvents(context)),
  );

  app.get(
    FEDERATION_PROTOCOL_ROUTE,
    nodeWs.upgradeWebSocket(() => {
      if (!federationProtocol) return { onOpen: (_event, ws) => ws.close(1008, 'Federation is disabled') };
      return federationProtocol.events();
    }),
  );

  app.get(
    PROTOCOL_SOCKET_ROUTE,
    nodeWs.upgradeWebSocket((context) => {
      const local = guard.listenerOf(context) === 'local';
      const deviceId = local ? undefined : remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
      const channel = deviceId === undefined ? undefined : remote.channelFor(deviceId, 'protocol');
      let handler: ReturnType<ReturnType<typeof createPiWebSocketListener>['accept']>;
      let untrack: (() => void) | undefined;
      const listener = createPiWebSocketListener({ onError: (error) => notice(`protocol: ${error.message}`) });
      let server: Server | undefined;
      let hubProtocol: ReturnType<typeof createHubProtocol> | undefined;
      let starting: Promise<void> = Promise.resolve();
      let receiving = Promise.resolve();
      let pendingBytes = 0;
      const maxPendingBytes = 64 * 1024 * 1024;
      let ended = false;
      let disconnectSocket = () => {};
      const cleanup = () => {
        if (ended) return;
        ended = true;
        protocolConnections.delete(cleanup);
        disconnectSocket();
        untrack?.();
        handler?.onClose();
        hubProtocol?.close();
        if (server) void server.close().catch((error: unknown) => notice(`protocol close: ${String(error)}`));
      };
      return {
        onOpen(_event, ws) {
          disconnectSocket = () => ws.close();
          protocolConnections.add(cleanup);
          if (!local && channel === undefined) {
            ws.close(1008, 'sealed protocol channel required');
            return;
          }
          if (deviceId !== undefined) untrack = remote.trackSocket(deviceId, (code, reason) => ws.close(code, reason));
          starting = (async () => {
            hubProtocol = createHubProtocol(hubEvents(context, true), () => ws.close());
            server = new Server(
              createPiHubService({
                records: () => hub.records(),
                // Session creation stays on HTTP, where remote requests require step-up.
                onNotice: notice,
                remote: federationDirectory?.remote,
                hub: hubProtocol.service,
              }),
              {
                serverId: DOOM_COCKPIT_SERVER_ID,
                listeners: [listener],
                onError: (error) => notice(`protocol: ${error.message}`),
              },
            );
            await server.start();
            if (ended) {
              await server.close();
              return;
            }
            handler = listener.accept({
              send: async (data) => {
                const raw = ws.raw;
                if (!raw || ended) throw new Error('The protocol socket is closed.');
                const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
                let outgoing = bytes;
                if (!local) {
                  if (!channel) throw new Error('The sealed protocol channel is missing.');
                  const sealed = channel.seal(bytes);
                  if (!sealed.ok) throw new Error('The sealed protocol channel failed.');
                  outgoing = new TextEncoder().encode(JSON.stringify(sealed.envelope));
                }
                if (raw.bufferedAmount + outgoing.byteLength > maxPendingBytes)
                  throw new Error('Protocol send queue exhausted.');
                await new Promise<void>((resolve, reject) =>
                  raw.send(outgoing, (error) => (error ? reject(error) : resolve())),
                );
              },
              close: () => ws.close(),
              get readyState() {
                return ws.readyState;
              },
            });
          })().catch((error: unknown) => {
            notice(`protocol startup: ${String(error)}`);
            cleanup();
            ws.close();
          });
        },
        onMessage(event) {
          if (ended) return;
          const data = event.data;
          if (typeof data === 'string') {
            cleanup();
            return;
          }
          const size = data instanceof Blob ? data.size : data.byteLength;
          if (pendingBytes + size > maxPendingBytes) {
            cleanup();
            return;
          }
          pendingBytes += size;
          receiving = receiving
            .then(async () => {
              await starting;
              if (ended) return;
              const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
              if (ended) return;
              if (local) {
                handler?.onData(bytes);
                return;
              }
              if (!channel) throw new Error('The sealed protocol channel is missing.');
              const envelope: unknown = JSON.parse(new TextDecoder().decode(bytes));
              const opened = channel.open(envelope);
              if (!opened.ok) throw new Error('The sealed protocol frame could not be opened.');
              handler?.onData(opened.plaintext);
            })
            .catch((error: unknown) => {
              notice(`protocol receive: ${String(error)}`);
              cleanup();
            })
            .finally(() => {
              pendingBytes -= size;
            });
        },
        onClose: cleanup,
        onError(event) {
          handler?.onError(event instanceof Error ? event : new Error('The protocol socket failed'));
          cleanup();
        },
      };
    }),
  );

  app.get('/manifest.webmanifest', (context) => {
    const file = path.join(pwaDir, 'manifest.webmanifest');
    const body = readAsset(file);
    if (body === undefined) return context.text('The PWA manifest is unavailable.', 404);
    return context.body(new Uint8Array(body), 200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/manifest+json; charset=utf-8',
    });
  });
  app.get('/sw.js', (context) => {
    const file = path.join(pwaDir, 'sw.js');
    const body = readAsset(file);
    if (body === undefined) return context.text('The trusted service worker is unavailable.', 404);
    return context.body(new Uint8Array(body), 200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
    });
  });
  app.get(`${PWA_ASSET_PREFIX}*`, (context) => {
    const requested = new URL(context.req.url).pathname.slice(PWA_ASSET_PREFIX.length);
    const file = resolveAssetPath(pwaDir, `/${requested}`);
    const body = file === undefined ? undefined : readAsset(file);
    if (file === undefined || body === undefined) return context.text('PWA asset not found.', 404);
    return context.body(new Uint8Array(body), 200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypeFor(file),
      'X-Content-Type-Options': 'nosniff',
    });
  });
  app.get(`${PLUGIN_BUNDLE_PREFIX}*`, (context) => {
    const requested = new URL(context.req.url).pathname;
    const matched = /^\/api\/web-plugins\/([a-f0-9]{64})\/([1-9][0-9]*)\/(manifest|assets(\/.*))$/u.exec(requested);
    const revision = matched === null ? undefined : Number(matched[2]);
    const published =
      matched === null || !Number.isSafeInteger(revision)
        ? undefined
        : pluginPublication.get(matched[1] ?? '', revision as number);
    if (matched === null || published === undefined) {
      return context.text('That signed plugin composition is unavailable.', 404);
    }
    if (matched[3] === 'manifest') {
      return context.json(published.signed, 200, { 'Cache-Control': 'no-store' });
    }
    const asset = assetFor(published.signed.manifest, matched[4] ?? '');
    const file = asset === undefined ? undefined : resolveAssetPath(published.assetsDir, asset.path);
    const body = file === undefined ? undefined : readAsset(file);
    if (asset === undefined || file === undefined || body === undefined) {
      return context.text('Plugin composition asset not found.', 404);
    }
    return context.body(new Uint8Array(body), 200, {
      'Cache-Control': 'no-store',
      'Content-Length': String(body.byteLength),
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
  });
  app.get(BUNDLE_MANIFEST_ROUTE, (context) => {
    const current = publication.current();
    if (current === undefined) return context.json({ error: 'No signed cockpit bundle is available.' }, 503);
    return context.json(current.signed, 200, { 'Cache-Control': 'no-store' });
  });
  app.get(`${RAW_BUNDLE_PREFIX}*`, (context) => {
    const requested = new URL(context.req.url).pathname;
    const matched = /^\/bundle-assets\/([1-9][0-9]*)(\/.*)$/u.exec(requested);
    const revision = matched === null ? undefined : Number(matched[1]);
    const current = publication.current();
    if (
      matched === null ||
      !Number.isSafeInteger(revision) ||
      current === undefined ||
      current.signed.manifest.revision !== revision
    ) {
      return context.text('That signed bundle revision is unavailable.', 404);
    }
    const asset = assetFor(current.signed.manifest, matched[2] ?? '');
    // Read through the directory this manifest was signed over, not whatever is
    // current now: a generation that changed mid-request would otherwise serve
    // bytes the page is about to reject as a digest mismatch.
    const file = asset === undefined ? undefined : resolveAssetPath(current.assetsDir, asset.path);
    const body = file === undefined ? undefined : readAsset(file);
    if (asset === undefined || file === undefined || body === undefined)
      return context.text('Bundle asset not found.', 404);
    return context.body(new Uint8Array(body), 200, {
      'Cache-Control': 'no-store',
      'Content-Length': String(body.byteLength),
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
  });
  app.get('/', (context) => context.redirect(PAIRING_PAGE_ROUTE));
  app.get('*', (context) => {
    const pathname = new URL(context.req.url).pathname;
    const acceptsHtml = context.req.header('accept')?.includes('text/html') === true;
    if (!pathname.startsWith('/api/') && acceptsHtml) return context.redirect('/');
    return context.text('Not found.', 404);
  });

  // Only the global cockpit configuration is watched. A completed global sync
  // reloads the matching sessions' plugins without replacing the stable shell.
  cockpitSyncGuard.watch(() => {
    for (const record of hub.records()) {
      if (compositionRoot(record.cwd) === cockpitRoot) hub.reloadChannels(record.id);
    }
  });

  return new Promise<WebServer>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: host }, (info) => {
      // Before this the guard has no loopback port to compare against and
      // treats everything as remote, which is the safe direction to be wrong in.
      loopbackPort = info.port;
      nodeWs.injectWebSocket(server);
      const url = `http://${host}:${info.port}`;
      notice(`cockpit on ${url}`);
      // Loopback rather than `host`, which may be 0.0.0.0 and is not an address
      // anything can connect to.
      const withdrawAdvertisement = advertiseHub({
        registryDir: options.registryDir,
        url: `http://127.0.0.1:${String(info.port)}`,
        onNotice: notice,
      });
      let closePromise: Promise<void> | undefined;
      const close = async (): Promise<void> => {
        // Remote access first, so the tunnel is down and every paired socket
        // is closed before the rest of the hub starts letting go.
        withdrawAdvertisement();
        await remote.close();
        await new Promise<void>((done) => {
          threads.close();
          cockpitSyncGuard.close();
          federationDirectory?.close();
          federationProtocol?.close();
          federationTransport?.close();
          for (const close of protocolConnections) close();
          disconnectApiBundleCleanup();
          disconnectLivePush();
          livePush?.close();
          hub.close();
          recordingArtifacts.close();
          providerAuth.close();
          void pluginApis.close();
          pluginPublication.close();
          // An upgraded socket leaves the HTTP server's connection tracking,
          // so only the WebSocket server can let go of it. Without this the
          // close callback waits on a browser that has no reason to leave.
          for (const client of nodeWs.wss.clients) client.terminate();
          nodeWs.wss.close();
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close(() => done());
        });
        await shutdownWebTelemetry(telemetry);
      };
      resolve({
        url,
        port: info.port,
        close: () => (closePromise ??= close()),
      });
    });
    server.once('error', (error) => {
      cockpitSyncGuard.close();
      threads.close();
      disconnectApiBundleCleanup();
      disconnectLivePush();
      livePush?.close();
      hub.close();
      recordingArtifacts.close();
      providerAuth.close();
      void remote.close();
      void pluginApis.close();
      pluginPublication.close();
      void telemetry.shutdown();
      reject(error);
    });
  });
}
