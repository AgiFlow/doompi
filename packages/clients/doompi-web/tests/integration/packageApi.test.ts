import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      return Response.json({ path: url.pathname, query: url.search, method: request.method });
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

describe('a package API reached through the hub', () => {
  it('proxies a session-scoped request to that session, keeping the path and dropping the routing parameter', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    const response = await fetch(`${server.url}/api/plugin/demo/runners/r1/log?session=session-a&grep=needle`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: '/api/plugin/demo/runners/r1/log',
      query: '?grep=needle',
      method: 'GET',
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

  it('leaves every other route alone, so the cockpit still serves itself', async () => {
    const socketPath = await fakeSessionApi();
    const { server } = await hubWith(socketPath);

    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    const fallback = await fetch(`${server.url}/some/page`);
    expect(fallback.status).toBe(500);
    expect(await fallback.text()).toContain('cockpit bundle is missing');
  });
});
