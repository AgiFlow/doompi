import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import {
  DOOM_API_CALLER_DEVICE_ID_HEADER,
  DOOM_API_CALLER_LOCALITY_HEADER,
  DOOM_API_CALLER_STEP_UP_HEADER,
  type DoomApi,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHubApis, serveWeb } from '../../src/adapters/httpServer.ts';
import { proxyToSocket } from '../../src/adapters/packageApiProxy.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));
let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cleanups = [];
});

/**
 * A stand-in session server: HTTP on a unix socket, exactly the way
 * doompi-server serves its packages' session APIs. It echoes what it was
 * handed so a test can tell whether the hub stripped its own routing
 * parameter and left the rest of the path alone.
 */
async function fakeSessionApi(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-api-sock-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'api.sock');
  const server = http.createServer(
    getRequestListener(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/plugin/demo/slow-stream') {
        let pending: NodeJS.Timeout | undefined;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: append\ndata: {"lines":["one"]}\n\n'));
            // The reader may cancel before this fires, which is exactly what
            // the streaming test does; enqueueing then would throw.
            pending = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('event: append\ndata: {"lines":["two"],"ended":true}\n\n'));
              controller.close();
            }, 60);
          },
          cancel() {
            if (pending !== undefined) clearTimeout(pending);
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        path: url.pathname,
        query: url.search,
        method: request.method,
        traceparent: request.headers.get('traceparent'),
        callerLocality: request.headers.get(DOOM_API_CALLER_LOCALITY_HEADER),
        callerDeviceId: request.headers.get(DOOM_API_CALLER_DEVICE_ID_HEADER),
        callerStepUp: request.headers.get(DOOM_API_CALLER_STEP_UP_HEADER),
      });
    }),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => void server.close(() => resolve())));
  return socketPath;
}

/** A hub in registry mode, so the session's record carries its API socket the way a real one does. */
async function hubWith(apiSocketPath?: string): Promise<{ server: WebServer; session: FakeSession; id: string }> {
  const registryDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-api-hub-')), 'run');
  cleanups.push(() => fs.rmSync(path.dirname(registryDir), { recursive: true, force: true }));
  const id = 'session-a';
  const session = await startFakeSession({
    id,
    registryDir,
    ...(apiSocketPath === undefined ? {} : { apiSocketPath }),
  });
  const server = await serveWeb({
    registryDir,
    port: 0,
    assetsDir: '/nonexistent-assets',
    remoteStateDir: path.join(registryDir, 'remote-state'),
  });
  cleanups.push(async () => {
    await server.close();
    await session.close();
  });
  // The hub discovers sessions by watching the registry, so wait for the record.
  const deadline = Date.now() + 5000;
  while (!(await fetch(`${server.url}/api/health`).then((r) => r.json())).sessions) {
    if (Date.now() > deadline) throw new Error('the hub never saw the session record');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { server, session, id };
}

describe('hub-scoped package APIs', () => {
  it('mounts an API discovered from a session composition after the shared route exists', async () => {
    const app = new Hono();
    const mounted = mountHubApis(
      app,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
    );
    const api: DoomApi = {
      basePath: 'metrics',
      start: () => ({
        fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
        close: () => undefined,
      }),
    };

    expect((await app.request('/api/plugin/metrics/report')).status).toBe(404);
    mounted.add([api]);

    const response = await app.request('/api/plugin/metrics/report');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: '/report' });
  });
});

describe('a package API reached through the hub', () => {
  it('proxies a session-scoped request to that session, keeping the path and dropping the routing parameter', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    const response = await fetch(`${server.url}/api/plugin/demo/runners/r1/log?session=session-a&grep=needle`, {
      headers: {
        [DOOM_API_CALLER_LOCALITY_HEADER]: 'remote',
        [DOOM_API_CALLER_DEVICE_ID_HEADER]: 'spoofed-device',
        [DOOM_API_CALLER_STEP_UP_HEADER]: 'verified',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: '/api/plugin/demo/runners/r1/log',
      query: '?grep=needle',
      method: 'GET',
      traceparent: null,
      callerLocality: 'local',
      callerDeviceId: null,
      callerStepUp: 'not-required',
    });
  });

  it('replaces caller-supplied identity with the trusted paired remote stamp', async () => {
    const socketPath = await fakeSessionApi();
    const response = await proxyToSocket({
      socketPath,
      path: '/api/plugin/demo/activate',
      method: 'POST',
      headers: new Headers({
        [DOOM_API_CALLER_LOCALITY_HEADER]: 'local',
        [DOOM_API_CALLER_DEVICE_ID_HEADER]: 'spoofed-device',
        [DOOM_API_CALLER_STEP_UP_HEADER]: 'not-required',
      }),
      body: null,
      caller: { locality: 'remote', deviceId: 'paired-phone', stepUp: 'verified' },
    });

    expect(await response.json()).toMatchObject({
      callerLocality: 'remote',
      callerDeviceId: 'paired-phone',
      callerStepUp: 'verified',
    });
  });
  it('streams a response through rather than buffering it, so a follow arrives as it is produced', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    const response = await fetch(`${server.url}/api/plugin/demo/slow-stream?session=session-a`);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const first = await reader.read();
    // The second chunk is 60ms behind; receiving the first before then is the
    // proof that nothing waited for the upstream to finish.
    expect(first.value).toContain('"lines":["one"]');
    await reader.cancel();
  });

  it('preserves a validated incoming trace when no child span context is available', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';

    const response = await fetch(`${server.url}/api/plugin/demo/trace?session=session-a`, {
      headers: { traceparent },
    });

    expect(await response.json()).toMatchObject({ traceparent });
  });

  it('closes idempotently for concurrent and repeated callers', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    await Promise.all([server.close(), server.close()]);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('says so when the session serves no package API, instead of leaving the page waiting', async () => {
    const { server } = await hubWith();

    const response = await fetch(`${server.url}/api/plugin/demo/x?session=session-a`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('no package API') });
  });

  it('refuses a session it does not manage', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    const response = await fetch(`${server.url}/api/plugin/demo/x?session=nobody`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'No session nobody.' });
  });

  it('recovers browser navigation without turning missing APIs into pages', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    const fallback = await fetch(`${server.url}/some/page`);
    expect(fallback.status).toBe(404);

    const navigation = await fetch(`${server.url}/some/page`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    expect(navigation.status).toBe(302);
    expect(navigation.headers.get('location')).toBe('/');

    const missingApi = await fetch(`${server.url}/api/missing`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    expect(missingApi.status).toBe(404);
  });
});
