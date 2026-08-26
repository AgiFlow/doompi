import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import {
  DOOM_API_ROUTE_PREFIX,
  type DoomApi,
  type DoomApiContext,
  type DoomApiHandler,
} from '@agimon-ai/doompi-extension-contracts/package-api';

/** The socket name beside the session's own, so one directory holds the pair. */
const API_SOCKET_NAME = 'api.sock';

export interface PackageApiServerOptions {
  /** Directory the session's sockets live in; the API socket joins them there. */
  socketDir: string;
  sessionId: string;
  cwd: string;
  apis: readonly DoomApi[];
  onNotice: (message: string) => void;
}

export interface PackageApiServer {
  /** Absolute path of the socket, for the registry record; undefined when nothing mounted. */
  readonly socketPath: string | undefined;
  close(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serves this session's package APIs over HTTP on a unix socket.
 *
 * A socket rather than a port: the session server is one of many on a machine,
 * ports are a finite shared namespace, and the only client is the hub, which
 * already knows this session's directory. Nothing here is reachable from the
 * network, so the surface adds no way to reach a session that did not exist
 * before.
 *
 * Each API is mounted under its own base path and sees requests with that
 * prefix stripped, so a package declares routes relative to itself.
 */
export async function serveSessionApis(options: PackageApiServerOptions): Promise<PackageApiServer> {
  if (options.apis.length === 0) return { socketPath: undefined, close: () => Promise.resolve() };

  const context: DoomApiContext = {
    scope: 'session',
    sessionId: options.sessionId,
    cwd: options.cwd,
    onNotice: options.onNotice,
  };
  const handlers = new Map<string, DoomApiHandler>();
  for (const api of options.apis) {
    if (handlers.has(api.basePath)) {
      options.onNotice(`package API '${api.basePath}' is already mounted; the first one keeps it`);
      continue;
    }
    try {
      handlers.set(api.basePath, api.start(context));
    } catch (error) {
      options.onNotice(`package API '${api.basePath}' did not start (${describeError(error)}); it stays unmounted`);
    }
  }
  if (handlers.size === 0) return { socketPath: undefined, close: () => Promise.resolve() };

  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${DOOM_API_ROUTE_PREFIX}/`))
      return Response.json({ error: 'Not found.' }, { status: 404 });
    const rest = url.pathname.slice(DOOM_API_ROUTE_PREFIX.length + 1);
    const slash = rest.indexOf('/');
    const basePath = slash === -1 ? rest : rest.slice(0, slash);
    const handler = handlers.get(basePath);
    if (handler === undefined)
      return Response.json({ error: `No API '${basePath}' in this session.` }, { status: 404 });
    url.pathname = slash === -1 ? '/' : rest.slice(slash);
    try {
      return await handler.fetch(new Request(url, request));
    } catch (error) {
      options.onNotice(`package API '${basePath}' failed on ${url.pathname} (${describeError(error)})`);
      return Response.json({ error: `The '${basePath}' API failed.` }, { status: 500 });
    }
  };

  const socketPath = path.resolve(options.socketDir, API_SOCKET_NAME);
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer(getRequestListener(dispatch));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const handler of handlers.values()) handler.close();
        server.closeAllConnections();
        server.close(() => {
          fs.rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
