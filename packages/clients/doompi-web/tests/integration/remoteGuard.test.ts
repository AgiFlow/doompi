import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));

const SESSION = 'guarded';
const HOSTILE_ORIGIN = 'https://evil.example';

let server: WebServer;
let session: FakeSession;
let registryDir: string;

beforeEach(async () => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-guard-'));
  session = await startFakeSession({ id: SESSION, registryDir, cwd: process.cwd() });
  server = await serveWeb({
    registryDir,
    spawnCommand: path.join(registryDir, 'no-such-server'),
    port: 0,
    assetsDir: '/nonexistent-assets',
  });
});

afterEach(async () => {
  await server.close();
  await session.close();
  fs.rmSync(registryDir, { recursive: true, force: true });
});

function loopbackOrigin(): string {
  return server.url;
}

/** Issues a request with an arbitrary Host header, which fetch refuses to send. */
function rawStatus(route: string, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: server.port, path: route, method: 'GET', headers: { host: hostHeader } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Resolves to the HTTP status when the handshake is refused, or 'open' when it completes. */
function tryUpgrade(route: string, headers: Record<string, string>): Promise<number | 'open'> {
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}${route}`, { headers });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The upgrade neither opened nor was refused.')), 5000);
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once('end', () => {
        clearTimeout(timer);
        socket.terminate();
        resolve(status);
      });
    });
    socket.on('open', () => {
      socket.close();
      socket.once('close', () => {
        clearTimeout(timer);
        resolve('open');
      });
    });
    socket.on('error', () => {
      // 'unexpected-response' fires first when the server answered; an error
      // without it means the socket died for another reason.
    });
  });
}

describe('the loopback listener refuses cross-site socket upgrades', () => {
  it.each(['/api/session', '/api/pi'])('refuses %s when a hostile page opens it', async (route) => {
    // WebSockets are exempt from CORS, so before the guard any web page could
    // open this and drive the agent. The browser always sends Origin, which is
    // what makes the refusal reliable.
    await expect(tryUpgrade(route, { origin: HOSTILE_ORIGIN })).resolves.toBe(403);
  });

  it.each(['/api/session', '/api/pi'])('still opens %s for the cockpit itself', async (route) => {
    await expect(tryUpgrade(route, { origin: loopbackOrigin() })).resolves.toBe('open');
  });

  it.each(['/api/session', '/api/pi'])('still opens %s for a client that sends no Origin', async (route) => {
    // curl, the health probe, and the e2e harness send none. Refusing them
    // would cost real usability and buy nothing: a local program can set any
    // Origin it likes, so this was never a defence against one.
    await expect(tryUpgrade(route, {})).resolves.toBe('open');
  });

  it('refuses an upgrade whose Host is not the loopback listener', async () => {
    await expect(tryUpgrade('/api/session', { host: 'attacker.test' })).resolves.toBe(403);
  });
});

describe('the loopback listener refuses cross-site mutations', () => {
  it('refuses a session spawn posted from a hostile page', async () => {
    // Hono does not check Content-Type, so text/plain skips the preflight and
    // a no-cors POST used to reach the handler. The attacker cannot read the
    // response, but spawning an agent in any directory is the whole payload.
    const response = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: HOSTILE_ORIGIN },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    expect(response.status).toBe(403);
    await response.text();
  });

  it('refuses a provider sign-out issued from a hostile page', async () => {
    const response = await fetch(`${server.url}/api/auth/providers/anthropic`, {
      method: 'DELETE',
      headers: { origin: HOSTILE_ORIGIN },
    });
    expect(response.status).toBe(403);
    await response.text();
  });

  it('still accepts a mutation from the cockpit', async () => {
    const response = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: loopbackOrigin() },
      body: JSON.stringify({}),
    });
    // 400 because the body has no cwd: the guard let it through to the handler,
    // which is what this asserts.
    expect(response.status).toBe(400);
    await response.text();
  });

  it('still accepts a mutation from a client that sends no Origin', async () => {
    const response = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    await response.text();
  });
});

describe('the loopback listener still answers the cockpit', () => {
  it('serves health to a plain probe', async () => {
    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, role: 'hub' });
  });

  it('refuses a request whose Host header names somewhere else', async () => {
    // node:http rather than fetch: undici treats Host as a forbidden header and
    // drops it silently, so a fetch-based version of this test would pass
    // against a server that had no Host check at all.
    await expect(rawStatus('/api/health', 'attacker.test')).resolves.toBe(403);
    await expect(rawStatus('/api/health', `127.0.0.1:${String(server.port)}`)).resolves.toBe(200);
  });
});
