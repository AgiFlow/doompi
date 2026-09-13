import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { packagedVersion } from './packageVersion.ts';
import { contentTypeFor, resolveAssetPath } from '../services/staticAssets.ts';
import type { WebServer, WebServerOptions } from '../types/bridge.ts';

const INDEX_FILE = 'index.html';
const WEB_DIST_ENV = 'DOOMPI_WEB_DIST';
const WEB_PACKAGE_ROOT_ENV = 'DOOMPI_WEB_PACKAGE_ROOT';
const DEFAULT_HEADLESS_URL = 'http://127.0.0.1:7434';
const PWA_ASSET_PREFIX = '/pwa/';
const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function packagedDirectory(name: 'web' | 'pwa'): string {
  const configuredRoot = process.env[WEB_PACKAGE_ROOT_ENV];
  if (configuredRoot !== undefined && configuredRoot !== '') return path.join(configuredRoot, 'dist', name);

  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return path.join(directory, 'dist', name);
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('doompi-web could not locate its own package root.');
    directory = parent;
  }
}

function packagedAssetsDir(): string {
  return packagedDirectory('web');
}

function packagedPwaDir(): string {
  return packagedDirectory('pwa');
}

export { packagedVersion };

function resolveAssetsDir(explicit: string | undefined): string {
  if (explicit !== undefined && explicit !== '') return path.resolve(explicit);
  const fromEnv = process.env[WEB_DIST_ENV];
  return fromEnv === undefined || fromEnv === '' ? packagedAssetsDir() : path.resolve(fromEnv);
}

function readAsset(filePath: string): Buffer | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? fs.readFileSync(filePath) : undefined;
  } catch {
    return undefined;
  }
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://doompi-web.local');
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_PROXY_BODY_BYTES) throw new Error('The request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function responseHeaders(headers: Headers, bodyLength: number): Record<string, string> {
  const copied: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-encoding' || name === 'content-length') continue;
    copied[name] = value;
  }
  copied['content-length'] = String(bodyLength);
  return copied;
}

function proxyHeaders(request: IncomingMessage, token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || name === 'host') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (token !== undefined && token !== '') headers['x-doompi-token'] = token;
  return headers;
}

async function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  headlessUrl: URL,
  token: string | undefined,
  notice: (message: string) => void,
): Promise<void> {
  const target = new URL(requestUrl(request).pathname + requestUrl(request).search, headlessUrl);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: proxyHeaders(request, token),
      ...(body === undefined ? {} : { body: body as unknown as BodyInit, duplex: 'half' as const }),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, responseHeaders(upstream.headers, bytes.byteLength));
    if (request.method === 'HEAD') response.end();
    else response.end(bytes);
  } catch (error) {
    notice(`headless request failed (${error instanceof Error ? error.message : String(error)})`);
    if (!response.headersSent) {
      const message = JSON.stringify({ error: 'The headless server is unavailable.' });
      response.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(message)),
      });
      response.end(message);
    } else response.destroy();
  }
}

function writeStatic(request: IncomingMessage, response: ServerResponse, assetsDir: string, pwaDir: string): void {
  const url = requestUrl(request);
  const fromPwa = url.pathname.startsWith(PWA_ASSET_PREFIX);
  const relativePath = fromPwa ? url.pathname.slice(PWA_ASSET_PREFIX.length) : url.pathname;
  const root = fromPwa ? pwaDir : assetsDir;
  let file = resolveAssetPath(root, relativePath === '' ? '/' : `/${relativePath}`);
  let body = file === undefined ? undefined : readAsset(file);

  if (body === undefined && !fromPwa && request.headers.accept?.includes('text/html') === true) {
    file = resolveAssetPath(assetsDir, `/${INDEX_FILE}`);
    body = file === undefined ? undefined : readAsset(file);
  }
  if (file === undefined || body === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found.');
    return;
  }

  response.writeHead(200, {
    'cache-control': fromPwa ? 'no-store' : 'public, max-age=31536000, immutable',
    'content-length': String(body.byteLength),
    'content-type': contentTypeFor(file),
    'x-content-type-options': 'nosniff',
    ...(url.pathname === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

function rawDataLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((size, chunk) => size + chunk.byteLength, 0) : data.byteLength;
}

function wsHeaders(request: IncomingMessage, token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token !== undefined && token !== '') headers['x-doompi-token'] = token;
  const protocol = request.headers['sec-websocket-protocol'];
  if (typeof protocol === 'string') headers['sec-websocket-protocol'] = protocol;
  return headers;
}

/**
 * Serves browser assets and forwards the browser protocol to the client-neutral
 * headless process. Session state, APIs, channels, and authorization stay there.
 */
export async function serveWeb(options: WebServerOptions): Promise<WebServer> {
  const host = options.host ?? '127.0.0.1';
  const notice = options.onNotice ?? ((): void => {});
  const assetsDir = resolveAssetsDir(options.assetsDir);
  const pwaDir = packagedPwaDir();
  const headlessUrl = new URL(options.headlessUrl ?? DEFAULT_HEADLESS_URL);
  const server = createServer((request, response) => {
    const url = requestUrl(request);
    if (url.pathname.startsWith('/api/')) {
      void proxyHttp(request, response, headlessUrl, options.headlessToken, notice);
      return;
    }
    writeStatic(request, response, assetsDir, pwaDir);
  });
  const sockets = new Set<WebSocket>();
  const webSockets = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (requestUrl(request).pathname !== '/api/pi') {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      sockets.add(client);
      const upstreamUrl = new URL(requestUrl(request).pathname + requestUrl(request).search, headlessUrl);
      upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const upstream = new WebSocket(upstreamUrl, { headers: wsHeaders(request, options.headlessToken) });
      const pending: RawData[] = [];
      let pendingBytes = 0;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        sockets.delete(client);
        client.close();
        upstream.close();
      };
      client.on('message', (data) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data);
          return;
        }
        pendingBytes += rawDataLength(data);
        if (pendingBytes > MAX_PROXY_BODY_BYTES) {
          close();
          return;
        }
        pending.push(data);
      });
      client.on('close', close);
      client.on('error', close);
      upstream.on('open', () => {
        for (const data of pending) upstream.send(data);
        pending.length = 0;
        pendingBytes = 0;
      });
      upstream.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      });
      upstream.on('close', close);
      upstream.on('error', (error) => {
        notice(`headless websocket failed (${error.message})`);
        close();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The web presentation server did not expose a TCP address.');
  }
  const url = `http://${host}:${String(address.port)}`;
  let closePromise: Promise<void> | undefined;
  return {
    url,
    port: address.port,
    close: () =>
      (closePromise ??= (async () => {
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        webSockets.close();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      })()),
  };
}
