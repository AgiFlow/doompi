import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

const { spawned } = vi.hoisted(() => ({ spawned: [] as Array<{ cwd: string; name?: string }> }));
vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));

vi.mock('../../src/adapters/serverSpawner.ts', () => ({
  createServerSpawner: () => ({
    spawn: async (input: { cwd: string; name?: string }) => {
      spawned.push(input);
      return { ok: true as const, sessionId: 'created' };
    },
  }),
}));
const SESSION = 'routed';

let server: WebServer;
let session: FakeSession;
let registryDir: string;
let assetsDir: string;

beforeEach(async () => {
  spawned.length = 0;
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

describe('signed bundle assets', () => {
  it('serves a real file only through its signed revision route', async () => {
    const envelope = (await (await fetch(url('/bundle-manifest.json'))).json()) as { manifest: { revision: number } };
    const response = await fetch(url(`/bundle-assets/${String(envelope.manifest.revision)}/assets/app.js`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(url('/assets/app.js'))).status).toBe(404);
  });

  it('leaves client-side routing to the verified service-worker cache', async () => {
    const response = await fetch(url('/settings/providers'));
    expect(response.status).toBe(404);
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
  it.each([
    ['Doom', (root: string) => fs.mkdirSync(path.join(root, '.doom'))],
    [
      'Pi',
      (root: string) => {
        fs.mkdirSync(path.join(root, '.pi'));
        fs.writeFileSync(path.join(root, '.pi', 'settings.json'), '{}');
      },
    ],
    ['Git', (root: string) => fs.mkdirSync(path.join(root, '.git'))],
  ])('creates a session in the selected directory below a %s-marked ancestor', async (_label, mark) => {
    const outer = path.join(registryDir, 'outer');
    const root = path.join(outer, 'project');
    const selected = path.join(root, 'packages', 'feature');
    fs.mkdirSync(selected, { recursive: true });
    fs.mkdirSync(path.join(outer, '.git'));
    mark(root);

    const response = await fetch(url('/api/sessions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: selected, name: 'selected' }),
    });

    expect(response.status).toBe(201);
    expect(spawned).toEqual([expect.objectContaining({ cwd: selected, name: 'selected' })]);
  });

  it('creates a session in the selected directory when no marked ancestor exists', async () => {
    const selected = path.join(registryDir, 'plain', 'nested');
    fs.mkdirSync(selected, { recursive: true });

    const response = await fetch(url('/api/sessions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: selected }),
    });

    expect(response.status).toBe(201);
    expect(spawned).toEqual([expect.objectContaining({ cwd: selected })]);
  });
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

describe('browser telemetry ingestion', () => {
  it('accepts the fixed bounded batch', async () => {
    const response = await fetch(url('/api/telemetry/browser'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, events: [{ name: 'web.browser.ready', duration_ms: 12 }] }),
    });
    expect(response.status).toBe(204);
  });

  it('rejects unknown fields and oversized bodies', async () => {
    const unknown = await fetch(url('/api/telemetry/browser'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, events: [{ name: 'web.browser.ready', path: '/private' }] }),
    });
    expect(unknown.status).toBe(400);

    const oversized = await fetch(url('/api/telemetry/browser'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, events: [], padding: 'x'.repeat(33 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  it('accepts a browser error and rejects one whose source is not a known site', async () => {
    const accepted = await fetch(url('/api/telemetry/browser'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        events: [
          {
            name: 'web.browser.error',
            source: 'window_error',
            error_name: 'TypeError',
            message: 'theme.fg is not a function',
            stack: 'TypeError: theme.fg is not a function\n  at render',
            session_id: 'session-7',
          },
        ],
      }),
    });
    expect(accepted.status).toBe(204);

    const rejected = await fetch(url('/api/telemetry/browser'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        events: [{ name: 'web.browser.error', source: 'anywhere', error_name: 'TypeError', message: 'boom' }],
      }),
    });
    expect(rejected.status).toBe(400);
  });
});
