import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { contentTypeFor, resolveAssetPath } from '../services/staticAssets.ts';
import type { WebServer, WebServerOptions } from '../types/bridge.ts';
import {
  HUB_PROTOCOL_VERSION,
  HUB_ROLE,
  hubHello,
  SESSION_COMMAND_TYPE,
  SESSION_REMOVED_TYPE,
  SESSION_UPSERT_TYPE,
  sessionFrameEnvelope,
  SESSIONS_API_ROUTE,
  SESSIONS_SNAPSHOT_TYPE,
  SUBAGENT_RUNS_TYPE,
  WORKFLOW_RUNS_TYPE,
  SUBSCRIBE_TYPE,
  UNSUBSCRIBE_TYPE,
} from '../types/hub.ts';
import type { SessionRecord } from '../types/registry.ts';
import { ATTACH_TYPE, type SessionFrame } from '../types/session.ts';
import { readGitStatus } from './gitStatus.ts';
import { staticRecordSource, watchRegistry } from './registryWatcher.ts';
import { createServerSpawner } from './serverSpawner.ts';
import { createSessionHub, type SessionHub } from './sessionHub.ts';

const SESSION_ROUTE = '/api/session';
const INDEX_FILE = 'index.html';
/** Stands in for a registry id in fixed single-session mode. */
const LOCAL_SESSION_ID = 'local';

/**
 * Locates the built SPA next to the package that owns this module.
 *
 * Walking to the manifest rather than counting `..` segments keeps this correct
 * whether the code runs from `src` in development or from the unbundled `dist`
 * tree, whose depth is a build detail.
 */
function defaultAssetsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'dist', 'web');
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('doompi-web could not locate its own package root.');
    dir = parent;
  }
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

function buildHub(options: WebServerOptions, notice: (message: string) => void): SessionHub {
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
export function serveWeb(options: WebServerOptions): Promise<WebServer> {
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const host = options.host ?? '127.0.0.1';
  const notice = options.onNotice ?? ((): void => {});
  const hub = buildHub(options, notice);
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });

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
          post(hubHello());
          post({ type: SESSIONS_SNAPSHOT_TYPE, sessions: hub.snapshot() });
          disconnect = hub.onEvent((event) => {
            if (event.kind === 'upsert') post({ type: SESSION_UPSERT_TYPE, session: event.session });
            else if (event.kind === 'removed') {
              subscriptions.delete(event.sessionId);
              post({ type: SESSION_REMOVED_TYPE, sessionId: event.sessionId });
            } else if (event.kind === 'runs') {
              if (subscriptions.has(event.sessionId)) {
                post({ type: SUBAGENT_RUNS_TYPE, sessionId: event.sessionId, runs: event.runs });
              }
            } else if (event.kind === 'workflows') {
              if (subscriptions.has(event.sessionId)) {
                post({ type: WORKFLOW_RUNS_TYPE, sessionId: event.sessionId, runs: event.runs });
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
              const runs = hub.runsFor(sessionId);
              if (runs) ws.send(JSON.stringify(runs));
              const workflows = hub.workflowsFor(sessionId);
              if (workflows) ws.send(JSON.stringify(workflows));
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
      reject(error);
    });
  });
}
