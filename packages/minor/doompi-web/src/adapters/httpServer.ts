import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';
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
  DIRECTORIES_API_ROUTE,
  SESSIONS_API_ROUTE,
  SESSIONS_SNAPSHOT_TYPE,
  SUBSCRIBE_TYPE,
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
import { listDirectories } from './directoryListing.ts';
import { listSessionFiles, readSessionFile } from './sessionFiles.ts';
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
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });
  // Provider credentials belong to the machine, not to a session: the hub
  // keeps one Pi runtime over the shared auth.json and signs in for all.
  const providerAuth = createProviderAuth({ runtime: options.authRuntime, onNotice: notice });
  registerAuthRoutes(app, providerAuth);

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

  // Directory completion for the new-session picker: the children of the
  // typed parent directory, filtered by the trailing segment as a regex.
  app.get(DIRECTORIES_API_ROUTE, async (context) => {
    const directories = await listDirectories(context.req.query('q') ?? '', DIRECTORY_SUGGESTION_LIMIT);
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
      let disconnect: (() => void) | undefined;
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
              post({ type: SESSION_REMOVED_TYPE, sessionId: event.sessionId });
            } else if (event.kind === 'channel') {
              if (subscriptions.has(event.sessionId)) {
                post({ type: event.frameType, sessionId: event.sessionId, payload: event.payload });
              }
            } else if (subscriptions.has(event.sessionId)) {
              post(sessionFrameEnvelope(event.sessionId, event.frame));
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
          if (parsed.type === SESSION_COMMAND_TYPE && isRecord(parsed.frame)) {
            // The hub owns the handshake; a page must not be able to replay it.
            if (parsed.frame.type === ATTACH_TYPE) return;
            hub.command(sessionId, parsed.frame);
          }
        },
        onClose() {
          disconnect?.();
          disconnect = undefined;
          subscriptions.clear();
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
            hub.close();
            providerAuth.close();
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
      hub.close();
      providerAuth.close();
      reject(error);
    });
  });
}
