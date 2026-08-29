import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { PiServer, PiServerError } from '@earendil-works/pi-server';
import { readSyncDrift } from '@agimon-ai/doompi/services';
import { readSyncState } from '@agimon-ai/doompi/services/syncState';
import type { DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { createPiHubService } from './piHubService.ts';
import { createSyncGuard } from './syncGuard.ts';
import { createPiWebSocketListener } from './piWebSocketListener.ts';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import {
  DOOM_API_ROUTE_PREFIX,
  type DoomApi,
  type DoomApiHandler,
  type DoomRepositorySyncView,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { loadPackageApis } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import { insideSandbox } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { findRepositoryRoot } from '@agimon-ai/doompi/utils/repository';
import { sessionFileHeaders } from '../services/fileMedia.ts';
import { contentTypeFor, resolveAssetPath } from '../services/staticAssets.ts';
import { MAX_SESSION_FILE_BYTES, SESSION_FILE_ROUTE } from '../types/media.ts';
import type { SettingsRepository } from '../types/settings.ts';
import type { WebServer, WebServerOptions } from '../types/bridge.ts';
import {
  API_SESSION_QUERY_PARAM,
  DIRECTORIES_API_ROUTE,
  HISTORY_REQUEST_TYPE,
  HUB_PROTOCOL_VERSION,
  HUB_RESYNCED_TYPE,
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
import { watchRegistry } from './registryWatcher.ts';
import { createServerSpawner } from './serverSpawner.ts';
import { createSessionHub, type SessionHub } from './sessionHub.ts';
import { allowedOriginsFromEnv } from '../services/remoteGuardPolicy.ts';
import { describeStranded, planSessionMigration } from '../services/sessionMigration.ts';
import { registerAuthRoutes } from './authRoutes.ts';
import { registerSettingsRoutes } from './settingsRoutes.ts';
import { createProviderAuth } from './providerAuth.ts';
import { createRemoteGuard } from './remoteGuard.ts';
import { createRemoteAccess } from './remoteAccess.ts';
import { createRemoteAccessStore } from './remoteAccessStore.ts';
import { registerRemoteRoutes } from './remoteRoutes.ts';
import { createTunnelLauncher, reapStaleTunnel } from './tunnelProcess.ts';
import {
  DEVICE_COOKIE,
  PROTOCOL_SOCKET_ROUTE,
  REMOTE_CHANNEL_ROUTE,
  REMOTE_HTTP_ROUTE,
  SESSION_SOCKET_ROUTE,
  type RemoteAccessSettings,
} from '../types/remoteAccess.ts';
import { suggestDirectories } from './directoryListing.ts';
import { listSessionFiles, readSessionFile } from './sessionFiles.ts';
import { proxyToSocket } from './packageApiProxy.ts';
import { createThreadJournals } from './threadJournals.ts';
import { loadHubChannels } from './webHubPluginLoader.ts';
import {
  createBrowserTelemetryRateLimit,
  createWebTelemetry,
  forwardedTraceContext,
  parseBrowserPerformanceBatch,
  readTraceContext,
  requestOperation,
  shutdownWebTelemetry,
  WEB_TELEMETRY_ROUTE,
} from './webTelemetry.ts';

// Pi's protocol rides its own socket so the DoomPi channel keeps the
// vocabulary the protocol has no shape for: dialogs, minor modes, selection.
/** Directory suggestions per picker query; more than this means "type further". */
const DIRECTORY_SUGGESTION_LIMIT = 12;
const INDEX_FILE = 'index.html';
/** Env override for the assets directory, set by launchers that know a synced bundle. */
const WEB_DIST_ENV = 'DOOMPI_WEB_DIST';
/** Comma-separated origins the operator allows past the guard, for dev setups this package cannot guess. */
const ALLOW_ORIGIN_ENV = 'DOOMPI_WEB_ALLOW_ORIGIN';
/** Where `doompi sync` publishes the machine's cockpit bundle. */
const SYNCED_WEB_DIRECTORY = ['.doompi', 'web', 'current', 'web'];
const SEALED_HTTP_VERSION = 1;
/** Upper bound for any body accepted from the tunnel before route-specific limits. */
const TUNNEL_BODY_BYTES = 8 * 1024 * 1024;
const TUNNEL_HEADER_BYTES = 16 * 1024;
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
function packagedAssetsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'dist', 'web');
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('doompi-web could not locate its own package root.');
    dir = parent;
  }
}

/**
 * The assets to serve, in preference order: an explicit option, the env
 * override, the bundle `doompi sync` published for this machine (which
 * carries the installed plugin set), then the package's own prebuilt bundle
 * (built-in plugins only).
 */
function resolveAssetsDir(explicit: string | undefined, notice: (message: string) => void): string {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env[WEB_DIST_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const synced = path.join(os.homedir(), ...SYNCED_WEB_DIRECTORY);
  if (fs.existsSync(path.join(synced, INDEX_FILE))) {
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One page's hold on one thread; a session id never contains a newline, so the pair cannot collide. */
function threadKey(sessionId: string, threadId: string): string {
  return `${sessionId}\n${threadId}`;
}

function buildHub(
  options: WebServerOptions,
  notice: (message: string) => void,
  channels: readonly WebHubChannel[],
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
    channels,
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
 */
function mountHubApis(
  app: Hono,
  apis: readonly DoomApi[],
  notice: (message: string) => void,
  resolveRepository: (repositoryId: string) => string | undefined,
  readRepositorySync: (repositoryId: string) => DoomRepositorySyncView | undefined,
): DoomApiHandler[] {
  const handlers: DoomApiHandler[] = [];
  for (const api of apis) {
    const mount = `${DOOM_API_ROUTE_PREFIX}/${api.basePath}`;
    let handler: DoomApiHandler;
    try {
      handler = api.start({ scope: 'hub', onNotice: notice, resolveRepository, readRepositorySync });
    } catch (error) {
      notice(`hub API '${api.basePath}' did not start (${describeError(error)}); its routes stay unmounted`);
      continue;
    }
    handlers.push(handler);
    app.all(`${mount}/*`, async (context) => {
      if (context.req.query(API_SESSION_QUERY_PARAM) !== undefined) return context.notFound();
      const url = new URL(context.req.url);
      url.pathname = url.pathname.slice(mount.length) || '/';
      try {
        return await handler.fetch(new Request(url, context.req.raw));
      } catch (error) {
        notice(`hub API '${api.basePath}' failed on ${url.pathname} (${describeError(error)})`);
        return context.json({ error: `The '${api.basePath}' API failed.` }, 500);
      }
    });
  }
  return handlers;
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
  const assetsDir = resolveAssetsDir(options.assetsDir, notice);
  const hub = buildHub(options, notice, await loadHubChannels(assetsDir, notice), telemetry);
  // Threads are journals the data channels can name (a subagent run's own
  // session file); the hub tails one only while a page follows it.
  const threads = createThreadJournals({
    resolve: (sessionId, threadId) => hub.threadJournal(sessionId, threadId),
    onNotice: notice,
  });
  // A session reads what sync produced, and nothing makes the person who
  // opened the cockpit run sync first. The hub keeps the repository current.
  const syncGuard = createSyncGuard({ cwd: process.cwd(), onNotice: notice });
  await syncGuard.ensureSynced();
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
  const store = createRemoteAccessStore({ stateDir: options.remoteStateDir, onNotice: notice });
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
    onNotice: notice,
    ...(handover === undefined ? {} : { requestHandover: handover }),
    contained: insideSandbox(process.env),
    broadcastLocal: (frame) => broadcast(frame, true),
    broadcastAll: (frame) => broadcast(frame, false),
    ...(options.remoteAccess?.now === undefined ? {} : { now: options.remoteAccess.now }),
  });
  // First route on the app, because Hono composes matching handlers in
  // registration order: a guard added after a terminating handler never runs
  // for that path. It also refuses socket upgrades, which is what closes the
  // cross-site WebSocket hijack that loopback binding never covered.
  const guard = createRemoteGuard({
    loopbackPort: () => loopbackPort,
    tunnelPolicy: () => remote.tunnelPolicy(),
    authorize: (context) => remote.authorize(getCookie(context, DEVICE_COOKIE, 'host')),
    trustedDevice: (context) => (context.env as SealedRequestBindings | undefined)?.sealedDeviceId,
    channelReady: (deviceId, scope) => remote.channelFor(deviceId, scope) !== undefined,
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
  const tunnelBodyLimit = bodyLimit({
    maxSize: TUNNEL_BODY_BYTES,
    onError: (context) => context.json({ error: 'The tunnel request body is too large.' }, 413),
  });
  app.use('*', async (context, next) => {
    if (guard.listenerOf(context) === 'local') return next();
    return await tunnelBodyLimit(context, next);
  });
  const browserTelemetryBodyLimit = bodyLimit({
    maxSize: 8 * 1024,
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
    const events = parseBrowserPerformanceBatch(body);
    if (events === undefined) return context.json({ error: 'The telemetry batch is invalid.' }, 400);
    for (const event of events) {
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
  // Every running session already serves Pi's protocol; the hub composes them
  // into one server so a browser sees a single endpoint with many sessions.
  // Remote clients get a distinct protocol service that can attach to existing
  // sessions but cannot bypass HTTP step-up by creating one directly.
  const localProtocolListener = createPiWebSocketListener({ onError: (error) => notice(`protocol: ${error.message}`) });
  const remoteProtocolListener = createPiWebSocketListener({
    onError: (error) => notice(`protocol: ${error.message}`),
  });
  const protocolService = createPiHubService({
    records: () => hub.records(),
    spawn: (input) => hub.create(input),
    onNotice: notice,
  });
  const remoteProtocolService = {
    ...protocolService,
    createSession: async () => {
      throw new PiServerError('not_implemented', 'Remote protocol clients cannot create sessions');
    },
  };
  const localProtocolServer = new PiServer(protocolService, {
    listeners: [localProtocolListener],
    onError: (error) => notice(`protocol: ${error.message}`),
  });
  const remoteProtocolServer = new PiServer(remoteProtocolService, {
    listeners: [remoteProtocolListener],
    onError: (error) => notice(`protocol: ${error.message}`),
  });
  await Promise.all([localProtocolServer.start(), remoteProtocolServer.start()]);
  // Provider credentials belong to the machine, not to a session: the hub
  // keeps one Pi runtime over the shared auth.json and signs in for all.
  const providerAuth = createProviderAuth({ runtime: options.authRuntime, onNotice: notice });
  registerAuthRoutes(app, providerAuth);
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
    let state: ReturnType<typeof readSyncState>;
    try {
      state = readSyncState(root);
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
  const pluginApis = mountHubApis(
    app,
    await loadPackageApis('hub', { onNotice: notice }),
    notice,
    resolveRepository,
    readRepositorySync,
  );
  mountSessionApiProxy(app, hub, notice, telemetry);

  app.get('/api/health', (context) =>
    context.json({
      ok: true,
      role: HUB_ROLE,
      protocol: HUB_PROTOCOL_VERSION,
      sessions: hub.snapshot().length,
      pid: process.pid,
    }),
  );

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
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined;
    await syncGuard.ensureSynced();
    const outcome = await hub.create({ cwd: body.cwd, name, trace: readTraceContext(context.req.raw.headers) });
    if (outcome.ok) return context.json({ sessionId: outcome.sessionId }, 201);
    return context.json({ error: outcome.error }, outcome.code === 'invalid_request' ? 400 : 502);
  });

  // A running server reads the composition once: its extensions when the agent
  // starts, its package API routes when the process does. So a rebuild reaches
  // an existing session only by replacing the process, and the sync has to
  // finish before the replacement starts or it reads the same stale artifacts.
  app.post(`${SESSIONS_API_ROUTE}/:sessionId/restart`, async (context) => {
    const sessionId = context.req.param('sessionId');
    await syncGuard.ensureSynced();
    const outcome = await hub.restart(sessionId, readTraceContext(context.req.raw.headers));
    if (outcome.ok) return context.json({ sessionId: outcome.sessionId }, 202);
    return context.json({ error: outcome.error }, outcome.code === 'invalid_request' ? 404 : 502);
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

  // The timeline's @file previews: one cwd-contained file, capped in size.
  app.get(SESSION_FILE_ROUTE, async (context) => {
    const sessionId = context.req.param('sessionId');
    const summary = hub.snapshot().find((candidate) => candidate.id === sessionId);
    if (!summary) return context.json({ error: 'Unknown session.' }, 404);
    const relativePath = context.req.query('path') ?? '';
    const file = await readSessionFile(summary.cwd, relativePath, MAX_SESSION_FILE_BYTES);
    if (file.status === 'forbidden') return context.json({ error: 'The path leaves the session directory.' }, 403);
    if (file.status === 'not-found') return context.json({ error: 'No such file.' }, 404);
    if (file.status === 'too-large') return context.json({ error: 'The file is too large to preview.' }, 413);
    return context.body(new Uint8Array(file.body), 200, sessionFileHeaders(relativePath));
  });

  app.get(
    SESSION_SOCKET_ROUTE,
    nodeWs.upgradeWebSocket((context) => {
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
          if (!local && channel === undefined) {
            ws.close(1008, 'sealed session channel required');
            return;
          }
          const post = (frame: SessionFrame | object): void => {
            const text = JSON.stringify(frame);
            let outgoing = text;
            if (!local) {
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
          post({ type: SESSIONS_SNAPSHOT_TYPE, sessions: hub.snapshot() });
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
          if (!local) {
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
            (subscriptions.has(sessionId) || hub.channelReceivesWithoutSubscription(parsed.type))
          ) {
            hub.receiveChannel(sessionId, parsed.type, parsed.payload, connectionId);
            return;
          }
          if (parsed.type === SUBSCRIBE_TYPE) {
            const backlog = hub.backlog(sessionId);
            if (!backlog) return; // Unknown session; the snapshot said otherwise.
            subscriptions.add(sessionId);
            registered?.post(backlog);
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
            if (threadSubscriptions.has(key) || hub.backlog(sessionId) === undefined) return;
            threadSubscriptions.set(key, { sessionId, threadId });
            registered?.post(threadBacklog(sessionId, threadId, threads.subscribe(sessionId, threadId)));
            return;
          }
          if (parsed.type === SESSION_COMMAND_TYPE && isRecord(parsed.frame)) {
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
    }),
  );

  app.get(
    PROTOCOL_SOCKET_ROUTE,
    nodeWs.upgradeWebSocket((context) => {
      const local = guard.listenerOf(context) === 'local';
      const deviceId = local ? undefined : remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
      const channel = deviceId === undefined ? undefined : remote.channelFor(deviceId, 'protocol');
      let handler: ReturnType<typeof localProtocolListener.accept>;
      let untrack: (() => void) | undefined;
      return {
        onOpen(_event, ws) {
          if (!local && channel === undefined) {
            ws.close(1008, 'sealed protocol channel required');
            return;
          }
          if (deviceId !== undefined) untrack = remote.trackSocket(deviceId, (code, reason) => ws.close(code, reason));
          handler = (local ? localProtocolListener : remoteProtocolListener).accept({
            send: (data) => {
              if (local) {
                ws.send(data as ArrayBuffer);
                return;
              }
              if (channel === undefined) return;
              const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
              const sealed = channel.seal(bytes);
              if (!sealed.ok) {
                ws.close(1008, 'sealed protocol channel failed');
                return;
              }
              ws.send(new TextEncoder().encode(JSON.stringify(sealed.envelope)));
            },
            close: () => ws.close(),
            get readyState() {
              return ws.readyState;
            },
          });
        },
        async onMessage(event) {
          const data = event.data;
          if (typeof data === 'string') return;
          const bytes =
            data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data);
          if (local) {
            handler?.onData(bytes);
            return;
          }
          if (channel === undefined) return;
          let envelope: unknown;
          try {
            envelope = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            return;
          }
          const opened = channel.open(envelope);
          if (opened.ok) handler?.onData(opened.plaintext);
        },
        onClose() {
          untrack?.();
          untrack = undefined;
          handler?.onClose();
          handler = undefined;
        },
        onError(event) {
          handler?.onError(event instanceof Error ? event : new Error('The protocol socket failed'));
          handler = undefined;
        },
      };
    }),
  );

  app.get('*', (context) => {
    const requested = new URL(context.req.url).pathname;
    const direct = requested === '/' ? undefined : resolveAssetPath(assetsDir, requested);
    const body = direct ? readAsset(direct) : undefined;
    if (direct && body) {
      return context.body(new Uint8Array(body), 200, { 'Content-Type': contentTypeFor(direct) });
    }
    const index = readAsset(path.join(assetsDir, INDEX_FILE));
    if (!index) return context.text('The cockpit bundle is missing. Run the package build.', 500);
    return context.body(new Uint8Array(index), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  // A rebuilt bundle only changes on disk, so the page it replaced has to be
  // told; nothing about a loaded bundle notices that its source moved.
  syncGuard.watch(() => {
    broadcast({ type: HUB_RESYNCED_TYPE }, false);
  });

  return new Promise<WebServer>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: host }, (info) => {
      // Before this the guard has no loopback port to compare against and
      // treats everything as remote, which is the safe direction to be wrong in.
      loopbackPort = info.port;
      nodeWs.injectWebSocket(server);
      const url = `http://${host}:${info.port}`;
      notice(`cockpit on ${url}`);
      let closePromise: Promise<void> | undefined;
      const close = async (): Promise<void> => {
        // Remote access first, so the tunnel is down and every paired socket
        // is closed before the rest of the hub starts letting go.
        await remote.close();
        await new Promise<void>((done) => {
          threads.close();
          syncGuard.close();
          void localProtocolServer.close();
          void remoteProtocolServer.close();
          hub.close();
          providerAuth.close();
          for (const handler of pluginApis) handler.close();
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
      threads.close();
      hub.close();
      providerAuth.close();
      void remote.close();
      for (const handler of pluginApis) handler.close();
      void telemetry.shutdown();
      reject(error);
    });
  });
}
