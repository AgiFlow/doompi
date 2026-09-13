import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { DOOM_API_CALLER_HEADERS, type DoomApiMount } from '../exports/packageApi';
import { observe, type ServerTelemetry } from '../services/serverTelemetry';
import type { SavedSession } from '../services/sqliteSessionHistory';
import type { HeadlessHub, HeadlessHubEvent, HeadlessHubSession } from './headlessHub';
import { createHeadlessProtocol } from './headlessProtocol';

const HEALTH_ROLE = 'hub';
const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HeadlessServerOptions {
  headlessHub: HeadlessHub;
  port: number;
  host?: string;
  /** Requests other than health require this bearer token when set. */
  token?: string;
  telemetry?: ServerTelemetry;
  onNotice?: (message: string) => void;
  compositions?: () => unknown;
  requestAsset?: (request: Request) => Promise<Response | undefined>;
  sessionHistory?: (session: HeadlessHubSession) => Promise<SavedSession[]>;
  restartSession?: (session: HeadlessHubSession) => Promise<void>;
  resumeSession?: (session: HeadlessHubSession, targetSessionId: string) => Promise<string>;
}

export interface HeadlessServer {
  readonly url: string;
  close(): Promise<void>;
}

type ProtocolHandler = NonNullable<ReturnType<Awaited<ReturnType<typeof createHeadlessProtocol>>['accept']>>;
type Client = { socket: WebSocket; handler: ProtocolHandler };

function sessionView(session: HeadlessHubSession): Record<string, unknown> {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    webComposition: session.webComposition,
    name: session.name,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    phase: session.phase ?? 'idle',
    phaseSince: session.phaseSince ?? session.createdAt,
    attach: 'attached',
    pendingMessageCount: session.pendingMessageCount ?? 0,
    everPrompted: session.everPrompted ?? false,
    awaitingInput: session.awaitingInput ?? false,
    ...(session.lastSettledAt === undefined ? {} : { lastSettledAt: session.lastSettledAt }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.sessionProvenance === undefined ? {} : { sessionProvenance: session.sessionProvenance }),
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (value?.startsWith('Bearer ')) return value.slice('Bearer '.length);
  const header = request.headers['x-doompi-token'];
  return typeof header === 'string' ? header : undefined;
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  if (bearer(request) === token) return true;
  try {
    return new URL(request.url ?? '/', 'http://doompi.local').searchParams.get('token') === token;
  } catch {
    return false;
  }
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://doompi.local');
}

async function directorySuggestions(query: string, sessions: readonly HeadlessHubSession[]): Promise<string[]> {
  const typed = query.trim();
  if (typed === '') return [];
  const matches = (value: string): boolean => value.toLowerCase().includes(typed.toLowerCase());
  const known = [...new Set([process.cwd(), ...sessions.map((session) => session.cwd)])].filter(matches);
  if (!path.isAbsolute(typed)) return known.slice(0, 12);
  const parent = path.dirname(typed);
  const partial = path.basename(typed).toLowerCase();
  try {
    const entries = await fs.promises.readdir(parent, { withFileTypes: true });
    const completed = entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes(partial))
      .map((entry) => path.join(parent, entry.name))
      .sort((left, right) => left.localeCompare(right));
    return [...new Set([...known, ...completed])].slice(0, 12);
  } catch {
    return known.slice(0, 12);
  }
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Uint8Array): unknown {
  if (body.byteLength === 0) return {};
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  if (result.body === null) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
}

function eventFrame(event: HeadlessHubEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'upsert':
      return { type: 'session_upsert', session: sessionView(event.session) };
    case 'removed':
      return { type: 'session_removed', sessionId: event.sessionId };
    case 'channel':
      return {
        type: 'channel_frame',
        frameType: event.frameType,
        sessionId: event.sessionId,
        payload: event.payload,
        ...(event.connectionId === undefined ? {} : { connectionId: event.connectionId }),
      };
  }
}

function writeSse(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

/**
 * Client-neutral HTTP and WebSocket boundary for the process-local headless hub.
 * It deliberately delegates every session operation to HeadlessHub, so transport
 * clients cannot create a second session backend or bypass its lifecycle.
 */
export async function serveHeadlessServer(options: HeadlessServerOptions): Promise<HeadlessServer> {
  const clients = new Set<Client>();
  const sse = new Set<ServerResponse>();
  let closed = false;
  const webSockets = new WebSocketServer({ noServer: true });
  const protocol = await createHeadlessProtocol({
    hub: options.headlessHub,
    telemetry: options.telemetry,
    onNotice: options.onNotice,
  });
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  const unsubscribe = options.headlessHub.onEvent((event) => {
    const frame = eventFrame(event);
    for (const response of sse) writeSse(response, String(frame.type), frame);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = requestPath(request);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      json(response, 200, {
        ok: true,
        role: HEALTH_ROLE,
        protocol: PROTOCOL_VERSION,
        sessions: options.headlessHub.snapshot().length,
      });
      return;
    }
    if (!authorized(request, options.token)) {
      json(response, 401, { error: 'Unauthorized.' });
      return;
    }
    if (url.pathname === '/api/remote' || url.pathname.startsWith('/api/remote/')) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== 'authorization' && name !== 'x-doompi-token')
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const result = await options.headlessHub.requestApi(
        { scope: 'global' },
        'remote',
        new Request(`http://doompi.local${url.pathname.slice('/api/remote'.length)}${url.search}`, {
          method: request.method,
          headers,
          ...(request.method === 'GET' || request.method === 'HEAD'
            ? {}
            : { body: Buffer.from(await readBody(request)) }),
        }),
      );
      await writeResponse(response, result);
      return;
    }
    if (url.pathname === '/api/telemetry/browser' && request.method === 'POST') {
      const body = JSON.parse(new TextDecoder().decode(await readBody(request))) as { v?: unknown; events?: unknown };
      if (body.v !== 1 || !Array.isArray(body.events) || body.events.length > 10) {
        json(response, 400, { error: 'Invalid browser telemetry batch.' });
        return;
      }
      for (const event of body.events) {
        if (
          !event ||
          typeof event !== 'object' ||
          typeof event.name !== 'string' ||
          !/^web\.browser\.[a-z_]{1,40}$/u.test(event.name)
        )
          continue;
        if (options.telemetry)
          observe(
            options.telemetry.recordEvent(event.name, {
              ...(typeof event.duration_ms === 'number' && Number.isFinite(event.duration_ms) && event.duration_ms >= 0
                ? { duration_ms: event.duration_ms }
                : {}),
              ...(typeof event.count === 'number' && Number.isFinite(event.count) && event.count >= 0
                ? { count: event.count }
                : {}),
            }),
          );
      }
      json(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/compositions' && request.method === 'GET') {
      json(response, 200, options.compositions?.() ?? { workspaces: [] });
      return;
    }
    if (
      (url.pathname.startsWith('/api/web-plugins/') ||
        url.pathname === '/bundle-manifest.json' ||
        url.pathname.startsWith('/bundle-assets/')) &&
      options.requestAsset
    ) {
      const result = await options.requestAsset(new Request(url, { method: request.method }));
      if (result) {
        await writeResponse(response, result);
        return;
      }
    }
    if (url.pathname === '/api/directories' && request.method === 'GET') {
      json(response, 200, {
        directories: await directorySuggestions(url.searchParams.get('q') ?? '', options.headlessHub.snapshot()),
      });
      return;
    }
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      const body: unknown = JSON.parse(new TextDecoder().decode(await readBody(request)));
      if (
        !body ||
        typeof body !== 'object' ||
        !('cwd' in body) ||
        typeof body.cwd !== 'string' ||
        !body.cwd.trim() ||
        ('name' in body && typeof body.name !== 'string')
      ) {
        json(response, 400, { error: 'A session needs a working directory and an optional name.' });
        return;
      }
      const created = await options.headlessHub.sessionService.create({
        cwd: body.cwd,
        name: 'name' in body ? String(body.name) : path.basename(body.cwd),
      });
      json(response, 201, { sessionId: created.sessionId });
      return;
    }
    if (url.pathname === '/api/sessions' && request.method === 'GET') {
      json(response, 200, { sessions: options.headlessHub.snapshot().map(sessionView) });
      return;
    }
    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      sse.add(response);
      response.on('close', () => sse.delete(response));
      writeSse(response, 'sessions_snapshot', {
        type: 'sessions_snapshot',
        sessions: options.headlessHub.snapshot().map(sessionView),
      });
      return;
    }
    if (url.pathname === '/api/workspaces') {
      if (request.method === 'GET') {
        json(response, 200, { workspaces: options.headlessHub.workspaces() });
        return;
      }
      if (request.method === 'POST') {
        const body = parseJson(await readBody(request));
        if (typeof body !== 'object' || body === null || !('root' in body) || typeof body.root !== 'string') {
          json(response, 400, { error: 'A workspace root is required.' });
          return;
        }
        const workspace = await options.headlessHub.admitWorkspace(body.root);
        json(response, 201, { workspace });
        return;
      }
    }
    const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/u.exec(url.pathname);
    if (workspaceMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(workspaceMatch[1]);
      if (!options.headlessHub.workspaces().some((workspace) => workspace.id === id)) {
        json(response, 404, { error: 'Workspace not found.' });
        return;
      }
      if (options.headlessHub.snapshot().some((session) => session.workspaceId === id)) {
        json(response, 409, { error: 'Workspace still has live sessions.' });
        return;
      }
      await options.headlessHub.removeWorkspace(id);
      json(response, 200, { ok: true });
      return;
    }
    const pluginMatch = /^\/api\/(global|workspaces\/([^/]+)|sessions\/([^/]+))\/plugin\/([^/]+)(?:\/(.*))?$/u.exec(
      url.pathname,
    );
    if (pluginMatch !== null && request.method !== 'CONNECT') {
      const mount: DoomApiMount =
        pluginMatch[2] !== undefined
          ? { scope: 'workspace', workspaceId: decodeURIComponent(pluginMatch[2]) }
          : pluginMatch[3] !== undefined
            ? { scope: 'session', sessionId: decodeURIComponent(pluginMatch[3]) }
            : { scope: 'global' };
      const basePath = decodeURIComponent(pluginMatch[4]);
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(basePath)) {
        json(response, 400, { error: 'Invalid package API base path.' });
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          !['host', 'authorization', 'x-doompi-token', ...DOOM_API_CALLER_HEADERS].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const abort = new AbortController();
      const disconnected = (): void => {
        if (!response.writableEnded) abort.abort();
      };
      response.once('close', disconnected);
      try {
        const started = performance.now();
        const attributes = {
          scope: mount.scope,
          'plugin.name': basePath,
          'http.operation': request.method,
          ...(mount.scope === 'workspace' ? { 'workspace.id': mount.workspaceId } : {}),
          ...(mount.scope === 'session' ? { 'session.id': mount.sessionId } : {}),
        };
        const dispatch = async () =>
          options.headlessHub.requestApi(
            mount,
            basePath,
            new Request(`http://doompi.local/${pluginMatch[5] ?? ''}${url.search}`, {
              method: request.method,
              headers,
              signal: abort.signal,
              ...(request.method === 'GET' || request.method === 'HEAD'
                ? {}
                : { body: Buffer.from(await readBody(request)) }),
            }),
          );
        const result = options.telemetry
          ? await options.telemetry.runInSpan('doompi_server.plugin.request', attributes, dispatch)
          : await dispatch();
        if (options.telemetry)
          observe(
            options.telemetry.recordEvent('doompi_server.plugin.response', {
              ...attributes,
              status: result.status,
              durationMs: performance.now() - started,
            }),
            options.onNotice,
          );
        await writeResponse(response, result);
      } finally {
        response.off('close', disconnected);
      }
      return;
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (sessionMatch === null) {
      json(response, 404, { error: 'Not found.' });
      return;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const session = options.headlessHub.session(sessionId);
    if (session === undefined) {
      json(response, 404, { error: 'Session not found.' });
      return;
    }
    const suffix = sessionMatch[2] === undefined ? '' : `/${sessionMatch[2]}`;
    if (suffix === '' && request.method === 'GET') {
      json(response, 200, sessionView(session));
      return;
    }
    if (suffix === '' && request.method === 'DELETE') {
      await options.headlessHub.closeSession(sessionId);
      json(response, 200, { ok: true });
      return;
    }
    if (suffix === '/history' && request.method === 'GET' && options.sessionHistory) {
      json(response, 200, { sessions: await options.sessionHistory(session) });
      return;
    }
    if (suffix === '/restart' && request.method === 'POST' && options.restartSession) {
      await options.restartSession(session);
      json(response, 200, { ok: true });
      return;
    }
    if (suffix === '/resume' && request.method === 'POST' && options.resumeSession) {
      const body = parseJson(await readBody(request));
      const targetSessionId =
        body && typeof body === 'object' && 'targetSessionId' in body ? body.targetSessionId : undefined;
      if (typeof targetSessionId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(targetSessionId)) {
        json(response, 400, { error: 'Invalid target session id.' });
        return;
      }
      json(response, 200, { sessionId: await options.resumeSession(session, targetSessionId) });
      return;
    }
    if (suffix === '/channels' && request.method === 'GET') {
      json(response, 200, { channels: options.headlessHub.channelFrames(sessionId) });
      return;
    }
    const channelMatch = /^\/channel\/([^/]+)$/u.exec(suffix);
    if (channelMatch !== null && request.method === 'POST') {
      const frameType = decodeURIComponent(channelMatch[1]);
      const connectionId = request.headers['x-doompi-connection'];
      options.headlessHub.receiveChannel(
        sessionId,
        frameType,
        parseJson(await readBody(request)),
        typeof connectionId === 'string' ? connectionId : 'http',
      );
      json(response, 202, { ok: true });
      return;
    }
    json(response, 404, { error: 'Not found.' });
  }

  server.on('upgrade', (request, socket, head) => {
    const url = requestPath(request);
    if (url.pathname !== '/api/pi') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorized(request, options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit('connection', client, request);
    });
  });
  webSockets.on('connection', (socket) => {
    const handler = protocol.accept(socket);
    if (!handler) return;
    const client: Client = { socket, handler };
    clients.add(client);
    socket.on('message', (data) => {
      if (Buffer.isBuffer(data)) handler.onData(data);
      else if (Array.isArray(data)) handler.onData(Buffer.concat(data));
      else handler.onData(new Uint8Array(data as ArrayBuffer));
    });
    socket.on('close', () => {
      clients.delete(client);
      handler.onClose();
    });
    socket.on('error', (error) => handler.onError(error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The headless server did not expose a TCP address.');
  }
  const host = options.host ?? '127.0.0.1';
  const url = `http://${host}:${address.port}`;
  return {
    url,
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const response of sse) response.end();
      sse.clear();
      await protocol.close();
      clients.clear();
      webSockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
