import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

/**
 * Hot module reload is the reason this relay exists, so these tests speak the
 * shape Vite speaks: a subprotocol on the handshake, then text frames in both
 * directions on a socket the browser opened first.
 */

// Proxy fixtures supply their own assets; never sync the developer's repositories or global config.
vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));

const SESSION = 'devproxy-socket';

interface Upstream {
  port: number;
  protocols: (string | undefined)[];
  paths: string[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const protocols: (string | undefined)[] = [];
  const paths: string[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (offered) => [...offered][0] ?? false });
  wss.on('connection', (socket, request) => {
    protocols.push(socket.protocol === '' ? undefined : socket.protocol);
    paths.push(request.url ?? '');
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        socket.send(Buffer.concat([Buffer.from('bin:'), data]), { binary: true });
        return;
      }
      socket.send(`echo:${data.toString()}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('upstream did not bind a port');
  return {
    port: address.port,
    protocols,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

let server: WebServer;
let session: FakeSession;
let registryDir: string;
let assetsDir: string;
let upstream: Upstream;

beforeEach(async () => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-devsock-'));
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-devsock-assets-'));
  fs.writeFileSync(path.join(registryDir, 'package.json'), '{"name":"doompi-web"}');
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>cockpit</title>');
  session = await startFakeSession({ id: SESSION, registryDir, cwd: registryDir });
  server = await serveWeb({
    registryDir,
    spawnCommand: path.join(registryDir, 'no-such-server'),
    port: 0,
    assetsDir,
    remoteStateDir: path.join(registryDir, 'state'),
  });
  upstream = await startUpstream();
  await fetch(`${server.url}/api/dev-proxy/targets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'storefront', port: upstream.port }),
  });
});

afterEach(async () => {
  await upstream?.close();
  await server?.close();
  await session?.close();
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

function socketUrl(route: string): string {
  return `${server.url.replace(/^http/u, 'ws')}${route}`;
}

async function openSocket(route: string, protocol?: string): Promise<WebSocket> {
  const socket = protocol === undefined ? new WebSocket(socketUrl(route)) : new WebSocket(socketUrl(route), protocol);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<{ text: string; binary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer, isBinary: boolean) => resolve({ text: data.toString(), binary: isBinary }));
  });
}

describe('dev proxy websocket relay', () => {
  it('relays a text frame both ways', async () => {
    const socket = await openSocket('/devproxy/storefront/');
    socket.send('ping');
    expect((await nextMessage(socket)).text).toBe('echo:ping');
    socket.close();
  });

  it('relays a binary frame as binary', async () => {
    const socket = await openSocket('/devproxy/storefront/');
    socket.send(Buffer.from([1, 2, 3]));
    const answer = await nextMessage(socket);
    expect(answer.binary).toBe(true);
    expect(answer.text.startsWith('bin:')).toBe(true);
    socket.close();
  });

  it('forwards the subprotocol, without which the Vite client gives up', async () => {
    const socket = await openSocket('/devproxy/storefront/', 'vite-hmr');
    expect(socket.protocol).toBe('vite-hmr');
    // A round trip first: the browser leg opens before the relay has finished
    // dialling the upstream, so asking the upstream what it saw is only a fair
    // question once a frame has been all the way there and back.
    socket.send('ready');
    await nextMessage(socket);
    expect(upstream.protocols.at(-1)).toBe('vite-hmr');
    socket.close();
  });

  it('passes the path through with its prefix, matching the configured base', async () => {
    const socket = await openSocket('/devproxy/storefront/hmr?token=abc');
    socket.send('ready');
    await nextMessage(socket);
    expect(upstream.paths.at(-1)).toBe('/devproxy/storefront/hmr?token=abc');
    socket.close();
  });

  it('does not lose a frame the browser sent before the upstream connected', async () => {
    // Vite's client speaks first. The relay opens its own socket only once the
    // browser's is established, so anything sent in that window has to queue.
    const socket = new WebSocket(socketUrl('/devproxy/storefront/'));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send('first');
    expect((await nextMessage(socket)).text).toBe('echo:first');
    socket.close();
  });

  it('closes the browser socket when the target does not exist', async () => {
    const socket = new WebSocket(socketUrl('/devproxy/ghost/'));
    const code = await new Promise<number>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    expect(code).toBe(1011);
  });
});
