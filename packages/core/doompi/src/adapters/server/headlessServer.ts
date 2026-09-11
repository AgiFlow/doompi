import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { HeadlessHub, HeadlessHubEvent, HeadlessHubSession } from './headlessHub.ts';
import { createHeadlessProtocol } from './headlessProtocol.ts';

const HEALTH_ROLE = 'hub';
const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HeadlessServerOptions {
  headlessHub: HeadlessHub;
  port: number;
  host?: string;
  /** Requests other than health require this bearer token when set. */
  token?: string;
  onNotice?: (message: string) => void;
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
    name: session.name,
    cwd: session.cwd,
    createdAt: session.createdAt,
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

function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  return result.arrayBuffer().then((body) => {
    response.end(Buffer.from(body));
  });
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
  const protocol = await createHeadlessProtocol({ hub: options.headlessHub, onNotice: options.onNotice });
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
    const apiMatch = /^\/api\/sessions\/([^/]+)\/api\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (apiMatch !== null && request.method !== 'CONNECT') {
      const apiSessionId = decodeURIComponent(apiMatch[1]);
      if (apiSessionId !== sessionId) {
        json(response, 404, { error: 'Session not found.' });
        return;
      }
      const basePath = apiMatch[2];
      const apiPath = `/${apiMatch[3] ?? ''}${url.search}`;
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(basePath)) {
        json(response, 400, { error: 'Invalid package API base path.' });
        return;
      }
      const result = await options.headlessHub.requestSessionApi(
        { sessionId, cwd: session.cwd },
        {
          basePath,
          path: apiPath,
          method: request.method ?? 'GET',
          body:
            request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await readBody(request)),
        },
      );
      await writeResponse(response, result);
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
