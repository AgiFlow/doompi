import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const SESSION = 'routed';

let server: WebServer;
let session: FakeSession;
let registryDir: string;
let assetsDir: string;

beforeEach(async () => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-routes-'));
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-assets-'));
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>cockpit</title>');
  fs.mkdirSync(path.join(assetsDir, 'assets'));
  fs.writeFileSync(path.join(assetsDir, 'assets', 'app.js'), 'globalThis.ok = 1;');
  session = await startFakeSession({ id: SESSION, registryDir, cwd: process.cwd() });
  server = await serveWeb({
    registryDir,
    spawnCommand: path.join(registryDir, 'no-such-server'),
    port: 0,
    assetsDir,
    remoteStateDir: path.join(registryDir, 'state'),
  });
});

afterEach(async () => {
  await server.close();
  await session.close();
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

const url = (route: string): string => `${server.url}${route}`;

describe('static assets', () => {
  it('serves a real file with its content type', async () => {
    const response = await fetch(url('/assets/app.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
  });

  it('falls back to the bundle for an unknown path, because the router is client side', async () => {
    const response = await fetch(url('/settings/providers'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('cockpit');
  });

  it('refuses a traversal out of the asset root', async () => {
    const response = await fetch(url('/..%2f..%2fetc%2fpasswd'));
    // Either refused outright or answered with the bundle, never the file.
    expect(await response.text()).not.toContain('root:');
  });
});

describe('session-scoped routes', () => {
  it('lists files in the session directory', async () => {
    const response = await fetch(url(`/api/sessions/${SESSION}/files?q=package`));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { files: string[] }).files.length).toBeGreaterThan(0);
  });

  it('reports an unknown session rather than an empty list', async () => {
    expect((await fetch(url('/api/sessions/nope/files'))).status).toBe(404);
    expect((await fetch(url('/api/sessions/nope/file?path=x'))).status).toBe(404);
  });

  it('reads a file inside the session directory', async () => {
    const response = await fetch(url(`/api/sessions/${SESSION}/file?path=package.json`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('doompi-web');
  });

  it('refuses a path that leaves the session directory', async () => {
    const response = await fetch(url(`/api/sessions/${SESSION}/file?path=../../../../etc/passwd`));
    expect(response.status).toBe(403);
  });

  it('reports a file that is not there', async () => {
    expect((await fetch(url(`/api/sessions/${SESSION}/file?path=nope.txt`))).status).toBe(404);
  });
});

describe('the directory picker', () => {
  it('suggests children of a directory it is given', async () => {
    const response = await fetch(url(`/api/directories?q=${encodeURIComponent(`${registryDir}/`)}`));
    expect(response.status).toBe(200);
    expect(Array.isArray(((await response.json()) as { directories: string[] }).directories)).toBe(true);
  });

  it('answers an empty query without failing', async () => {
    expect((await fetch(url('/api/directories'))).status).toBe(200);
  });
});

describe('session lifecycle routes', () => {
  it('refuses a create with no cwd', async () => {
    const response = await fetch(url('/api/sessions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no cwd' }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a create whose body is not JSON', async () => {
    const response = await fetch(url('/api/sessions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('reports an unknown session on delete', async () => {
    expect((await fetch(url('/api/sessions/nope'), { method: 'DELETE' })).status).toBe(404);
  });
});

describe('plugin APIs', () => {
  it('reports a session that serves no package API', async () => {
    const response = await fetch(url(`/api/plugin/anything?session=${SESSION}`));
    expect(response.status).toBe(404);
  });

  it('reports an unknown session on a proxied call', async () => {
    expect((await fetch(url('/api/plugin/anything?session=nope'))).status).toBe(404);
  });
});
