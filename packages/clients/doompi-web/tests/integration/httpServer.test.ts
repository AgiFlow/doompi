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
  let notices: string[];
  let upstreamStreamClosed: Promise<void>;
  let markUpstreamStreamClosed: (() => void) | undefined;
  let slowStarted: Promise<void>;
  let markSlowStarted: (() => void) | undefined;
  let slowClosed: Promise<void>;
  let markSlowClosed: (() => void) | undefined;

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
    notices = [];
    upstreamStreamClosed = new Promise<void>((resolve) => {
      markUpstreamStreamClosed = resolve;
    });
    slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    slowClosed = new Promise<void>((resolve) => {
      markSlowClosed = resolve;
    });
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
        finishStream = () => {
          if (!response.destroyed) response.end('second\n');
        };
        request.on('close', () => markUpstreamStreamClosed?.());
        markStreamStarted?.();
        return;
      }
      // Never answers: stands in for headless work still running when the page reloads.
      if (request.url === '/api/slow') {
        request.on('close', () => markSlowClosed?.());
        markSlowStarted?.();
        return;
      }
      if (
        request.url === '/.well-known/oauth-authorization-server' ||
        request.url?.startsWith('/.well-known/oauth-protected-resource/') === true ||
        request.url?.startsWith('/oauth/authorize') === true ||
        request.url === '/oauth/token'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ path: request.url, token: request.headers['x-doompi-token'] }));
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
      onNotice: (message) => notices.push(message),
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
    for (const path of ['/api/remote/frontend', '/api/plugins/remote/frontend']) {
      expect((await fetch(`${presentation.url}${path}`, { method: 'POST' })).status).toBe(404);
    }
  });

  it('proxies public OAuth discovery and endpoint paths outside the API namespace', async () => {
    for (const requestPath of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/api/workspaces/work/sessions/session/mcp',
      '/oauth/authorize?client_id=test',
    ]) {
      const response = await fetch(`${presentation.url}${requestPath}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ path: requestPath, token: 'test-token' });
    }
    const token = await fetch(`${presentation.url}/oauth/token`, { method: 'POST', body: 'grant_type=test' });
    expect(token.status).toBe(200);
    expect(await token.json()).toEqual({ path: '/oauth/token', token: 'test-token' });
    expect((await fetch(`${presentation.url}/oauth/register`, { method: 'POST' })).status).toBe(404);
  });

  it('guards host-only MCP management before injecting the headless credential', async () => {
    const management = '/api/workspaces/work/sessions/session/mcp/clients';
    expect((await fetch(`${presentation.url}${management}`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(
      (
        await fetch(`${presentation.url}${management}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-doompi-mcp-csrf': '1' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${presentation.url}${management}`, {
          headers: { origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);

    const target = new URL(presentation.url);
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = requestHttp(
        {
          hostname: target.hostname,
          port: target.port,
          path: management,
          headers: { host: 'attacker.example' },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.once('error', reject);
      request.end();
    });
    expect(rebound).toBe(403);
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
  it('stays quiet when the browser aborts mid-response', async () => {
    const target = new URL(presentation.url);
    const first = await new Promise<string>((resolve, reject) => {
      const client = requestHttp(
        { hostname: target.hostname, method: 'GET', path: '/api/stream', port: target.port },
        (response) => {
          response.once('data', (chunk: Buffer) => {
            // Exactly what a page reload does to every in-flight proxied request.
            client.destroy();
            resolve(chunk.toString('utf8'));
          });
        },
      );
      // The abort surfaces on the client socket; the assertion is about the server.
      client.once('error', () => {});
      client.end();
      setTimeout(() => reject(new Error('The proxy never streamed a chunk.')), 2_000).unref();
    });
    expect(first).toBe('first\n');

    await upstreamStreamClosed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notices).toEqual([]);
  });

  it('cancels upstream work when the browser aborts before the response starts', async () => {
    const target = new URL(presentation.url);
    const client = requestHttp({ hostname: target.hostname, method: 'GET', path: '/api/slow', port: target.port });
    client.once('error', () => {});
    client.end();
    await slowStarted;
    client.destroy();

    await Promise.race([
      slowClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('The proxy left the headless request running.')), 2_000).unref(),
      ),
    ]);
    expect(notices).toEqual([]);
  });

  it('keeps authority-like request paths on the configured headless origin', async () => {
    const response = await rawGet(presentation.url, '//attacker.invalid/api/health');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, token: 'test-token' });
  });

  it('relays the browser protocol WebSocket without owning session state', async () => {
    const socket = new WebSocket(`${presentation.url.replace('http', 'ws')}/api/ws`);
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
