import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import {
  DOOM_API_ROUTE_PREFIX,
  type DoomApi,
  type DoomApiHandler,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { loadPackageApis } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import { sessionFileHeaders } from '../services/fileMedia.ts';
import { contentTypeFor, resolveAssetPath } from '../services/staticAssets.ts';
import { MAX_SESSION_FILE_BYTES, SESSION_FILE_ROUTE } from '../types/media.ts';
import type { WebServer, WebServerOptions } from '../types/bridge.ts';
import {
  HUB_PROTOCOL_VERSION,
  HUB_ROLE,
  hubHello,
  SESSION_COMMAND_TYPE,
  SESSION_REMOVED_TYPE,
  SESSION_UPSERT_TYPE,
  sessionFrameEnvelope,
  API_SESSION_QUERY_PARAM,
  DIRECTORIES_API_ROUTE,
  HISTORY_REQUEST_TYPE,
  SESSIONS_API_ROUTE,
  SESSIONS_SNAPSHOT_TYPE,
  SUBSCRIBE_THREAD_TYPE,
  SUBSCRIBE_TYPE,
  threadBacklog,
  threadFrameEnvelope,
  UNSUBSCRIBE_THREAD_TYPE,
  UNSUBSCRIBE_TYPE,
} from '../types/hub.ts';
import type { SessionRecord } from '../types/registry.ts';
import { ATTACH_TYPE, type SessionFrame } from '../types/session.ts';
import { readGitStatus } from './gitStatus.ts';
import { staticRecordSource, watchRegistry } from './registryWatcher.ts';
import { createServerSpawner } from './serverSpawner.ts';
import { createSessionHub, type SessionHub } from './sessionHub.ts';
import { registerAuthRoutes } from './authRoutes.ts';
import { createProviderAuth } from './providerAuth.ts';
import { suggestDirectories } from './directoryListing.ts';
import { listSessionFiles, readSessionFile } from './sessionFiles.ts';
import { proxyToSocket } from './packageApiProxy.ts';
import { createThreadJournals } from './threadJournals.ts';
import { loadHubChannels } from './webHubPluginLoader.ts';

const SESSION_ROUTE = '/api/session';
/** Directory suggestions per picker query; more than this means "type further". */
const DIRECTORY_SUGGESTION_LIMIT = 12;
const INDEX_FILE = 'index.html';
/** Stands in for a registry id in fixed single-session mode. */
const LOCAL_SESSION_ID = 'local';
/** Env override for the assets directory, set by launchers that know a synced bundle. */
const WEB_DIST_ENV = 'DOOMPI_WEB_DIST';
/** Where `doompi sync` publishes the machine's cockpit bundle. */
const SYNCED_WEB_DIRECTORY = ['.doompi', 'web', 'current', 'web'];

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
): SessionHub {
  if (options.registryDir !== undefined) {
    if (options.socketPath !== undefined || options.token !== undefined) {
      throw new Error('Pass either a registry directory or a socket, not both.');
    }
    return createSessionHub({
      source: watchRegistry(options.registryDir, notice),
      spawner: createServerSpawner({
        registryDir: options.registryDir,
        command: options.spawnCommand,
        onNotice: notice,
      }),
      readGit: readGitStatus,
      channels,
      onNotice: notice,
    });
  }
  if (options.socketPath === undefined || options.token === undefined) {
    throw new Error('Pass a registry directory for hub mode, or a socket path and token for single-session mode.');
  }
  const token = options.token;
  const record: SessionRecord = {
    version: 1,
    id: LOCAL_SESSION_ID,
    name: 'untitled',
    cwd: process.cwd(),
    socketPath: options.socketPath,
    tokenFile: '',
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  return createSessionHub({
    source: staticRecordSource(record),
    readGit: readGitStatus,
    readToken: () => token,
    channels,
    onNotice: notice,
  });
}

/**
 * Mounts the hub-scoped package APIs under /api/plugin/<basePath>/.
 *
 * The prefix is stripped before the API sees the request, so a package
 * declares its routes relative to its own mount and never repeats where a host
 * put it. An API that throws answers 500 for its own routes alone; one bad
 * package never takes the cockpit down with it.
 */
function mountHubApis(app: Hono, apis: readonly DoomApi[], notice: (message: string) => void): DoomApiHandler[] {
  const handlers: DoomApiHandler[] = [];
  for (const api of apis) {
    const mount = `${DOOM_API_ROUTE_PREFIX}/${api.basePath}`;
    let handler: DoomApiHandler;
    try {
      handler = api.start({ scope: 'hub', onNotice: notice });
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
function mountSessionApiProxy(app: Hono, hub: SessionHub, notice: (message: string) => void): void {
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
    try {
      return await proxyToSocket({
        socketPath: summary.apiSocketPath,
        path: `${url.pathname}${url.search}`,
        method: context.req.method,
        headers: context.req.raw.headers,
        body: context.req.raw.body,
      });
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
  const assetsDir = resolveAssetsDir(options.assetsDir, notice);
  const hub = buildHub(options, notice, await loadHubChannels(assetsDir, notice));
  // Threads are journals the data channels can name (a subagent run's own
  // session file); the hub tails one only while a page follows it.
  const threads = createThreadJournals({
    resolve: (sessionId, threadId) => hub.threadJournal(sessionId, threadId),
    onNotice: notice,
  });
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });
  // Provider credentials belong to the machine, not to a session: the hub
  // keeps one Pi runtime over the shared auth.json and signs in for all.
  const providerAuth = createProviderAuth({ runtime: options.authRuntime, onNotice: notice });
  registerAuthRoutes(app, providerAuth);
  // Package APIs, mounted before the SPA fallback so their routes are reachable
  // and everything else still falls through to the bundle. Hub-scoped ones run
  // here; session-scoped ones live in each session's own server and are proxied.
  const pluginApis = mountHubApis(app, await loadPackageApis('hub', { onNotice: notice }), notice);
  mountSessionApiProxy(app, hub, notice);

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
    const outcome = await hub.create({ cwd: body.cwd, name });
    if (outcome.ok) return context.json({ sessionId: outcome.sessionId }, 201);
    return context.json({ error: outcome.error }, outcome.code === 'invalid_request' ? 400 : 502);
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

  // Directory suggestions for the new-session picker: the children of the
  // typed parent while a path is being drilled into, and a ranked search of
  // the home directory for anything else, so a name or a path remembered from
  // another machine still finds the folder.
  app.get(DIRECTORIES_API_ROUTE, async (context) => {
    const directories = await suggestDirectories(context.req.query('q') ?? '', {
      limit: DIRECTORY_SUGGESTION_LIMIT,
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
    SESSION_ROUTE,
    nodeWs.upgradeWebSocket(() => {
      const subscriptions = new Set<string>();
      /** The threads this page follows; one socket may follow several of one session. */
      const threadSubscriptions = new Map<string, { sessionId: string; threadId: string }>();
      let disconnect: (() => void) | undefined;
      let disconnectThreads: (() => void) | undefined;
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
          const post = (frame: SessionFrame | object): void => {
            try {
              ws.send(JSON.stringify(frame));
            } catch {
              // The browser went away mid-write; onClose tears the socket down.
            }
          };
          post(hubHello(hub.channelTypes()));
          post({ type: SESSIONS_SNAPSHOT_TYPE, sessions: hub.snapshot() });
          disconnect = hub.onEvent((event) => {
            if (event.kind === 'upsert') post({ type: SESSION_UPSERT_TYPE, session: event.session });
            else if (event.kind === 'removed') {
              subscriptions.delete(event.sessionId);
              releaseThreads(event.sessionId);
              post({ type: SESSION_REMOVED_TYPE, sessionId: event.sessionId });
            } else if (event.kind === 'channel') {
              if (subscriptions.has(event.sessionId)) {
                post({ type: event.frameType, sessionId: event.sessionId, payload: event.payload });
              }
            } else if (subscriptions.has(event.sessionId)) {
              post(sessionFrameEnvelope(event.sessionId, event.frame));
            }
          });
          disconnectThreads = threads.onFrame((event) => {
            if (threadSubscriptions.has(threadKey(event.sessionId, event.threadId))) {
              post(threadFrameEnvelope(event.sessionId, event.threadId, event.frame));
            }
          });
          notice('browser attached');
        },
        onMessage(event, ws) {
          if (typeof event.data !== 'string') return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!isRecord(parsed) || typeof parsed.sessionId !== 'string') return;
          const sessionId = parsed.sessionId;
          if (parsed.type === SUBSCRIBE_TYPE) {
            const backlog = hub.backlog(sessionId);
            if (!backlog) return; // Unknown session; the snapshot said otherwise.
            subscriptions.add(sessionId);
            try {
              ws.send(JSON.stringify(backlog));
              for (const frame of hub.channelFrames(sessionId)) ws.send(JSON.stringify(frame));
            } catch {
              // The browser went away mid-write; onClose tears the socket down.
            }
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
            try {
              ws.send(JSON.stringify(page));
            } catch {
              // The browser went away mid-write; onClose tears the socket down.
            }
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
            try {
              ws.send(JSON.stringify(threadBacklog(sessionId, threadId, threads.subscribe(sessionId, threadId))));
            } catch {
              // The browser went away mid-write; onClose tears the socket down.
            }
            return;
          }
          if (parsed.type === SESSION_COMMAND_TYPE && isRecord(parsed.frame)) {
            // The hub owns the handshake; a page must not be able to replay it.
            if (parsed.frame.type === ATTACH_TYPE) return;
            hub.command(sessionId, parsed.frame);
          }
        },
        onClose() {
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

  return new Promise<WebServer>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: host }, (info) => {
      nodeWs.injectWebSocket(server);
      const url = `http://${host}:${info.port}`;
      notice(`cockpit on ${url}`);
      resolve({
        url,
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            threads.close();
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
          }),
      });
    });
    server.once('error', (error) => {
      threads.close();
      hub.close();
      providerAuth.close();
      for (const handler of pluginApis) handler.close();
      reject(error);
    });
  });
}
