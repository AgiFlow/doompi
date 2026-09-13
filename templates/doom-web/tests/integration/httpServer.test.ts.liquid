import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';

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

describe('the web presentation server', () => {
  let assetsDir: string;
  let upstream: Server;
  let upstreamUrl: string;
  let presentation: WebServer;
  let upstreamSockets: WebSocketServer;

  beforeEach(async () => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-assets-'));
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>cockpit</title>');
    fs.mkdirSync(path.join(assetsDir, 'assets'));
    fs.writeFileSync(path.join(assetsDir, 'assets', 'app.js'), 'globalThis.cockpit = true;');
    upstream = createServer((request, response) => {
      if (request.url !== '/api/health') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, token: request.headers['x-doompi-token'] }));
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
    await presentation.close();
    upstreamSockets.close();
    await closeServer(upstream);
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  it('serves browser assets and forwards headless HTTP with its credential', async () => {
    const asset = await fetch(`${presentation.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('globalThis.cockpit');

    const health = await fetch(`${presentation.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, token: 'test-token' });
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
