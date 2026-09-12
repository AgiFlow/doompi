import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteAccess, type RemoteAccess } from './remoteAccess.ts';
import { createRemoteAccessStore } from './remoteAccessStore.ts';
import { registerRemoteRoutes } from './remoteRoutes.ts';
import { createTunnelLauncher, reapStaleTunnel } from './tunnelProcess.ts';
import {
  DEVICE_COOKIE,
  REMOTE_CHANNEL_ROUTE,
  REMOTE_HTTP_ROUTE,
  STEP_UP_HEADER,
  type TunnelLauncher,
} from './remoteTypes.ts';
import { isPublicPairingRoute, originVerdict, type GuardListener, localOriginPolicy } from './remoteGuardPolicy.ts';
import { stepUpActionFor } from './webauthnPolicy.ts';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const TUNNEL_HEADERS_TIMEOUT_MS = 5_000;
const TUNNEL_REQUEST_TIMEOUT_MS = 10_000;
const TUNNEL_CONNECTION_LIMIT = 64;
const TUNNEL_REQUESTS_PER_SOCKET = 100;
const SEALED_HTTP_VERSION = 1;
const SEALED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'transfer-encoding',
  'upgrade',
  'x-doompi-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

interface SealedHttpRequest {
  v: number;
  method: string;
  target: string;
  headers: Array<[string, string]>;
  body?: string;
}

function sealedRequest(value: unknown): SealedHttpRequest | undefined {
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
  )
    return undefined;
  const parsed = new URL(request.target, 'http://doompi.local');
  if (parsed.pathname === REMOTE_HTTP_ROUTE || parsed.pathname === REMOTE_CHANNEL_ROUTE) return undefined;
  return request as SealedHttpRequest;
}

function decodedBody(value: string | undefined): Buffer | undefined {
  if (value === undefined) return Buffer.alloc(0);
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)) return undefined;
  const body = Buffer.from(value, 'base64');
  return body.toString('base64') === value ? body : undefined;
}

interface ListenerBindings {
  listener: GuardListener;
  incoming?: IncomingMessage;
  sealedDeviceId?: string;
}

export interface RemoteRuntimeOptions {
  homeDirectory: string;
  registrationToken: string;
  bundleTrust(): { publicKey: string; revision: number } | undefined;
  onNotice(message: string): void;
  /** The listener to which a sealed, authenticated request is forwarded. */
  forward(request: Request): Promise<Response>;
  connectProtocol(): WebSocket;
  launchTunnel?: TunnelLauncher;
}

export interface RemoteRuntime {
  readonly remote: RemoteAccess;
  fetchLocal(request: Request): Promise<Response>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error('The tunnel request body is too large.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  if (result.body === null) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
}

/** One global control plane and a second socket dedicated to public tunnel traffic. */
export function createRemoteRuntime(options: RemoteRuntimeOptions): RemoteRuntime {
  const store = createRemoteAccessStore({
    stateDir: path.join(options.homeDirectory, '.doompi', 'web'),
    onNotice: (message) => options.onNotice(message),
  });
  reapStaleTunnel(store.directory, (message) => options.onNotice(message));
  const app = new Hono<{ Bindings: ListenerBindings }>();
  let remote: RemoteAccess;
  let frontendOrigin: string | undefined;
  app.use('*', async (context, next) => {
    if (context.env.listener === 'local') return next();
    const verdict = originVerdict({
      listener: 'tunnel',
      method: context.req.method,
      isUpgrade: false,
      origin: context.req.header('origin'),
      host: context.req.header('host'),
      local: localOriginPolicy(0),
      tunnel: remote.tunnelPolicy(),
    });
    if (verdict !== 'allow') return context.json({ error: `Tunnel request refused: ${verdict}.` }, 403);
    const path = context.req.path;
    if (isPublicPairingRoute(context.req.method, path)) return next();
    const device = remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    if (device === undefined) return context.json({ error: 'This device is not paired.' }, 401);
    if (context.env.sealedDeviceId === device) return next();
    if (context.req.method === 'POST' && (path === REMOTE_CHANNEL_ROUTE || path === REMOTE_HTTP_ROUTE)) return next();
    if ((context.req.method === 'GET' || context.req.method === 'HEAD') && !path.startsWith('/api/')) return next();
    return context.json({ error: 'Remote HTTP requests must use the sealed gateway.' }, 401);
  });

  remote = createRemoteAccess({
    store,
    launchTunnel:
      options.launchTunnel ??
      createTunnelLauncher({
        stateDir: store.directory,
        onNotice: (message) => options.onNotice(message),
        onExit: (message) => {
          options.onNotice(`remote access: ${message}`);
          void remote.disable();
        },
      }),
    bindListener: async () => {
      const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES });
      const server = createServer((incoming, outgoing) => {
        void (async () => {
          const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'localhost'}`);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : await readBody(incoming);
          const request = new Request(url, {
            method: incoming.method,
            headers,
            ...(body === undefined ? {} : { body }),
          });
          await writeResponse(outgoing, await app.fetch(request, { listener: 'tunnel', incoming }));
        })().catch((error: unknown) => {
          options.onNotice(`tunnel request failed: ${String(error)}`);
          if (!outgoing.headersSent) {
            outgoing.writeHead(500, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify({ error: 'The tunnel request failed.' }));
          } else outgoing.destroy();
        });
      });
      server.on('upgrade', (incoming, socket, head) => {
        const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'localhost'}`);
        const verdict = originVerdict({
          listener: 'tunnel',
          method: incoming.method ?? 'GET',
          isUpgrade: true,
          origin: incoming.headers.origin,
          host: incoming.headers.host,
          local: localOriginPolicy(0),
          tunnel: remote.tunnelPolicy(),
        });
        const cookies = new Map(
          (incoming.headers.cookie ?? '').split(';').map((part) => {
            const at = part.indexOf('=');
            return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
          }),
        );
        const device = remote.authorize(cookies.get(`__Host-${DEVICE_COOKIE}`));
        const channel = device === undefined ? undefined : remote.channelFor(device, 'protocol');
        if (url.pathname !== '/api/pi' || verdict !== 'allow' || !device || !channel) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        webSockets.handleUpgrade(incoming, socket, head, (client) => {
          let upstream: WebSocket;
          try {
            upstream = options.connectProtocol();
          } catch (error) {
            options.onNotice(`remote protocol could not connect: ${String(error)}`);
            client.close(1011, 'protocol unavailable');
            return;
          }
          const pending: Buffer[] = [];
          let pendingBytes = 0;
          let closed = false;
          const untrack = remote.trackSocket(device, (code, reason) => client.close(code, reason));
          const close = (): void => {
            if (closed) return;
            closed = true;
            untrack();
            client.close();
            upstream.close();
          };
          client.on('message', (raw: RawData) => {
            if (closed) return;
            const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
            let envelope: unknown;
            try {
              envelope = JSON.parse(bytes.toString('utf8')) as unknown;
            } catch {
              close();
              return;
            }
            const opened = channel.open(envelope);
            if (!opened.ok) {
              close();
              return;
            }
            const plain = Buffer.from(opened.plaintext);
            if (upstream.readyState === WebSocket.OPEN) upstream.send(plain);
            else {
              pendingBytes += plain.byteLength;
              if (pendingBytes > MAX_REQUEST_BYTES) close();
              else pending.push(plain);
            }
          });
          upstream.on('open', () => {
            for (const bytes of pending) upstream.send(bytes);
            pending.length = 0;
            pendingBytes = 0;
          });
          upstream.on('message', (raw: RawData) => {
            if (closed) return;
            const plain = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as Buffer);
            const sealed = channel.seal(plain);
            if (!sealed.ok) {
              close();
              return;
            }
            client.send(Buffer.from(JSON.stringify(sealed.envelope)));
          });
          client.on('close', close);
          client.on('error', close);
          upstream.on('close', close);
          upstream.on('error', (error) => {
            options.onNotice(`remote protocol failed: ${error.message}`);
            close();
          });
        });
      });
      server.headersTimeout = TUNNEL_HEADERS_TIMEOUT_MS;
      server.requestTimeout = TUNNEL_REQUEST_TIMEOUT_MS;
      server.maxConnections = TUNNEL_CONNECTION_LIMIT;
      server.maxRequestsPerSocket = TUNNEL_REQUESTS_PER_SOCKET;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('The tunnel listener has no TCP address.');
      return {
        port: address.port,
        close: async () => {
          for (const client of webSockets.clients) client.terminate();
          webSockets.close();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
      };
    },
    bundleTrust: () => options.bundleTrust(),
    onNotice: (message) => options.onNotice(message),
  });
  registerRemoteRoutes(app as unknown as Hono, {
    remote,
    listenerOf: (context) => (context.env as ListenerBindings).listener,
  });
  app.post('/api/remote/frontend', async (context) => {
    if (context.env.listener !== 'local')
      return context.json({ error: 'This action is only available on the host.' }, 403);
    if (context.req.header('x-doompi-web-registration') !== options.registrationToken)
      return context.json({ error: 'The web presentation server was not authenticated.' }, 403);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'A loopback web origin is required.' }, 400);
    }
    const origin = typeof body === 'object' && body !== null && 'origin' in body ? body.origin : undefined;
    if (typeof origin !== 'string') return context.json({ error: 'A loopback web origin is required.' }, 400);
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return context.json({ error: 'The web origin is invalid.' }, 400);
    }
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      !parsed.port
    )
      return context.json({ error: 'The web origin must be a loopback HTTP listener.' }, 400);
    frontendOrigin = parsed.origin;
    return context.json({ ok: true });
  });
  app.post(REMOTE_HTTP_ROUTE, async (context) => {
    const device = remote.authorize(getCookie(context, DEVICE_COOKIE, 'host'));
    const channel = device === undefined ? undefined : remote.channelFor(device, 'http');
    if (!device || !channel) return context.json({ error: 'A sealed paired device is required.' }, 401);
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
      decoded = JSON.parse(new TextDecoder().decode(opened.plaintext)) as unknown;
    } catch {
      return context.json({ error: 'The sealed HTTP request was malformed.' }, 400);
    }
    const inner = sealedRequest(decoded);
    const body = decodedBody(inner?.body);
    if (!inner || !body) return context.json({ error: 'The sealed HTTP request was invalid.' }, 400);
    const target = new URL(inner.target, 'http://doompi.local');
    const headers = new Headers();
    for (const [name, value] of inner.headers) {
      const normalized = name.toLowerCase();
      if (FORBIDDEN_HEADERS.has(normalized) || normalized.startsWith('sec-')) continue;
      headers.append(name, value);
    }
    const action = stepUpActionFor(inner.method, target.pathname);
    if (action && remote.stepUpRequired(action)) {
      const assertion = headers.get(STEP_UP_HEADER);
      let credential: unknown;
      try {
        credential = assertion ? JSON.parse(Buffer.from(assertion, 'base64url').toString('utf8')) : undefined;
      } catch {
        credential = undefined;
      }
      const ceremony = credential as { ceremonyId?: unknown; response?: unknown } | undefined;
      if (
        typeof ceremony?.ceremonyId !== 'string' ||
        !(await remote.passkeys().finishStepUp(ceremony.ceremonyId, `device:${device}`, action, ceremony.response))
      )
        return context.json({ error: 'This action needs a fresh passkey gesture.', action }, 401);
    }
    headers.delete(STEP_UP_HEADER);
    const internal = new Request(target, {
      method: inner.method,
      headers,
      ...(inner.method === 'GET' || inner.method === 'HEAD' ? {} : { body }),
    });
    let response: Response;
    if (target.pathname === '/api/remote' || target.pathname.startsWith('/api/remote/')) {
      headers.set('cookie', context.req.header('cookie') ?? '');
      headers.set('host', context.req.header('host') ?? '');
      headers.set('origin', context.req.header('origin') ?? '');
      response = await app.fetch(new Request(internal, { headers }), {
        listener: 'tunnel',
        sealedDeviceId: device,
      });
    } else response = await options.forward(internal);
    const responseBody = Buffer.from(await response.arrayBuffer());
    const sealed = channel.seal(
      new TextEncoder().encode(
        JSON.stringify({
          v: SEALED_HTTP_VERSION,
          status: response.status,
          headers: [...response.headers.entries()],
          body: responseBody.toString('base64'),
        }),
      ),
    );
    return sealed.ok
      ? context.json(sealed.envelope)
      : context.json({ error: `The sealed response failed: ${sealed.failure}.` }, 503);
  });
  app.on(['GET', 'HEAD'], '*', async (context) => {
    if (context.req.path.startsWith('/api/')) return context.json({ error: 'Not found.' }, 404);
    if (context.req.path === '/' && remote.authorize(getCookie(context, DEVICE_COOKIE, 'host')) === undefined)
      return context.redirect('/pair');
    if (!frontendOrigin) return context.json({ error: 'The web presentation server is unavailable.' }, 503);
    const from = new URL(context.req.url);
    const target = new URL(`${from.pathname}${from.search}`, frontendOrigin);
    const result = await fetch(target, { method: context.req.method, redirect: 'manual' });
    const headers = new Headers(result.headers);
    headers.delete('set-cookie');
    return new Response(result.body, { status: result.status, headers });
  });

  return {
    remote,
    fetchLocal: async (request) => app.fetch(request, { listener: 'local' }),
    close: async () => remote.close(),
  };
}
