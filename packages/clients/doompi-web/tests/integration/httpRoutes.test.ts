import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { SESSION_FILE_EXPECTED_SHA256_HEADER, SESSION_FILE_SHA256_HEADER } from '../../src/types/media.ts';
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
  fs.writeFileSync(path.join(registryDir, 'package.json'), '{"name":"doompi-web"}');
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><title>cockpit</title>');
  fs.mkdirSync(path.join(assetsDir, 'assets'));
  fs.writeFileSync(path.join(assetsDir, 'assets', 'app.js'), 'globalThis.ok = 1;');
  session = await startFakeSession({ id: SESSION, registryDir, cwd: registryDir });
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
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function projectPlan(activation?: 'inactive' | 'activating' | 'active' | 'deactivating'): Promise<void> {
  await session.waitForAttach();
  session.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'doom-minor-modes',
      data: {
        version: 1,
        revision: 1,
        modes: activation === undefined ? [] : [{ id: 'plan', activation }],
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

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

  it('reads a file with its digest and supports one byte range for video', async () => {
    fs.writeFileSync(path.join(registryDir, 'clip.mp4'), '0123456789');
    const response = await fetch(url(`/api/sessions/${SESSION}/file?path=clip.mp4`), {
      headers: { range: 'bytes=2-5' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get(SESSION_FILE_SHA256_HEADER)).toBe(sha256('0123456789'));
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe('2345');

    const multiple = await fetch(url(`/api/sessions/${SESSION}/file?path=clip.mp4`), {
      headers: { range: 'bytes=0-1,3-4' },
    });
    expect(multiple.status).toBe(416);
    expect(multiple.headers.get('content-range')).toBe('bytes */10');
  });

  it('requires an authoritative inactive Plan projection and the expected digest to save', async () => {
    const route = `/api/sessions/${SESSION}/file?path=package.json`;
    const unavailable = await fetch(url(route), {
      method: 'PUT',
      headers: { [SESSION_FILE_EXPECTED_SHA256_HEADER]: sha256('{"name":"doompi-web"}') },
      body: '{"name":"changed"}',
    });
    expect(unavailable.status).toBe(423);

    await projectPlan('inactive');
    const stale = await fetch(url(route), {
      method: 'PUT',
      headers: { [SESSION_FILE_EXPECTED_SHA256_HEADER]: '0'.repeat(64) },
      body: '{"name":"changed"}',
    });
    expect(stale.status).toBe(409);

    const saved = await fetch(url(route), {
      method: 'PUT',
      headers: { [SESSION_FILE_EXPECTED_SHA256_HEADER]: sha256('{"name":"doompi-web"}') },
      body: '{"name":"changed"}',
    });
    expect(saved.status).toBe(204);
    expect(saved.headers.get(SESSION_FILE_SHA256_HEADER)).toBe(sha256('{"name":"changed"}'));
    expect(fs.readFileSync(path.join(registryDir, 'package.json'), 'utf8')).toBe('{"name":"changed"}');
  });

  it('allows a valid projection where Plan is absent', async () => {
    await projectPlan();
    const response = await fetch(url(`/api/sessions/${SESSION}/file?path=package.json`), {
      method: 'PUT',
      headers: { [SESSION_FILE_EXPECTED_SHA256_HEADER]: sha256('{"name":"doompi-web"}') },
      body: '{"name":"changed"}',
    });
    expect(response.status).toBe(204);
  });

  it.each(['activating', 'active', 'deactivating'] as const)('locks a save while Plan is %s', async (activation) => {
    await projectPlan(activation);
    const response = await fetch(url(`/api/sessions/${SESSION}/file?path=package.json`), {
      method: 'PUT',
      headers: { [SESSION_FILE_EXPECTED_SHA256_HEADER]: sha256('{"name":"doompi-web"}') },
      body: '{"name":"changed"}',
    });
    expect(response.status).toBe(423);
    expect(fs.readFileSync(path.join(registryDir, 'package.json'), 'utf8')).toBe('{"name":"doompi-web"}');
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
