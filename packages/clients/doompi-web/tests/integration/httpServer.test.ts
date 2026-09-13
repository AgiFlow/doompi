import fs from 'node:fs';
import { createServer, request as requestHttp, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { serveWeb } from '../../src/adapters/httpServer';
import type { WebServer } from '../../src/types/bridge';

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The test server did not expose a TCP address.'));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function rawGet(origin: string, requestPath: string): Promise<{ body: string; status: number }> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      { hostname: target.hostname, method: 'GET', path: requestPath, port: target.port },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString('utf8'), status: response.statusCode ?? 0 }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

describe('the web presentation server', () => {
  let assetsDir: string;
  let upstream: Server;
  let upstreamUrl: string;
  let presentation: WebServer;
  let upstreamSockets: WebSocketServer;
  let registration: { origin: string; token: string | undefined; proof: string | undefined } | undefined;
  let streamStarted: Promise<void>;
  let markStreamStarted: (() => void) | undefined;
  let finishStream: (() => void) | undefined;

  beforeEach(async () => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-assets-'));
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>cockpit</title>');
    fs.mkdirSync(path.join(assetsDir, 'assets'));
    fs.writeFileSync(path.join(assetsDir, 'assets', 'app.js'), 'globalThis.cockpit = true;');
    registration = undefined;
    streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    finishStream = undefined;
    upstream = createServer((request, response) => {
      if (request.url === '/api/remote/frontend' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          registration = {
            origin: (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { origin: string }).origin,
            token: request.headers['x-doompi-token'] as string | undefined,
            proof: request.headers['x-doompi-web-registration'] as string | undefined,
          };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (request.url === '/api/stream') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('first\n');
        finishStream = () => response.end('second\n');
        markStreamStarted?.();
        return;
      }
      if (request.url !== '/api/health') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          token: request.headers['x-doompi-token'],
          registration: request.headers['x-doompi-web-registration'],
        }),
      );
    });
    upstreamSockets = new WebSocketServer({ server: upstream });
    upstreamSockets.on('connection', (socket) => {
      socket.on('message', (message) => socket.send(message));
    });
    upstreamUrl = await listen(upstream);
    presentation = await serveWeb({
      port: 0,
      assetsDir,
      headlessUrl: upstreamUrl,
      headlessToken: 'test-token',
    });
  });

  afterEach(async () => {
    finishStream?.();
    await presentation.close();
    upstreamSockets.close();
    await closeServer(upstream);
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  it('serves browser assets and forwards headless HTTP with its credential', async () => {
    expect(registration).toEqual({ origin: presentation.url, token: 'test-token', proof: 'test-token' });
    const asset = await fetch(`${presentation.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('globalThis.cockpit');

    const manifest = await fetch(`${presentation.url}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(await manifest.json()).toMatchObject({ name: 'DoomPi Cockpit' });

    const health = await fetch(`${presentation.url}/api/health`, {
      headers: { 'x-doompi-web-registration': 'browser-forgery' },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, token: 'test-token' });
    for (const path of ['/api/remote/frontend', '/api/global/plugin/remote/frontend']) {
      expect((await fetch(`${presentation.url}${path}`, { method: 'POST' })).status).toBe(404);
    }
  });

  it('streams headless HTTP responses without waiting for the upstream body to end', async () => {
    const pending = fetch(`${presentation.url}/api/stream`);
    await streamStarted;
    const streamed = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The proxy buffered the stream.')), 1_000)),
    ]);
    const reader = streamed.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value ?? []).toString('utf8')).toBe('first\n');

    finishStream?.();
    const second = await reader.read();
    expect(Buffer.from(second.value ?? []).toString('utf8')).toBe('second\n');
  });
  it('keeps authority-like request paths on the configured headless origin', async () => {
    const response = await rawGet(presentation.url, '//attacker.invalid/api/health');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, token: 'test-token' });
  });

  it('relays the browser protocol WebSocket without owning session state', async () => {
    const socket = new WebSocket(`${presentation.url.replace('http', 'ws')}/api/pi`);
    const received = new Promise<string>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('message', (data) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        resolve(bytes.toString());
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send('protocol-frame');
    expect(await received).toBe('protocol-frame');
    socket.close();
  });
});
