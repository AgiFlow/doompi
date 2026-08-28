import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DoomApi, DoomApiContext } from '@agimon-ai/doompi-extension-contracts/package-api';
import { serveSessionApis } from '../../src/adapters/packageApiServer.ts';
import type { ServerTelemetry } from '../../src/adapters/serverTelemetry.ts';

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cleanups = [];
});

function socketDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-session-api-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One request over the session's API socket, the way the hub's proxy makes it. */
function request(
  socketPath: string,
  requestPath: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = http.request({ socketPath, path: requestPath, method: 'GET', headers }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => (body += chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
    });
    call.once('error', reject);
    call.end();
  });
}

/** An API that reports what it was started with and what path it was handed. */
function echoApi(basePath: string, seen?: { context?: DoomApiContext }): DoomApi {
  return {
    basePath,
    start(context) {
      if (seen) seen.context = context;
      return {
        fetch: (incoming) => Response.json({ basePath, path: new URL(incoming.url).pathname }),
        close: () => undefined,
      };
    },
  };
}

describe('serving a session package APIs', () => {
  it('listens on a socket beside the session and answers under each base path', async () => {
    const dir = socketDir();
    const server = await serveSessionApis({
      socketDir: dir,
      sessionId: 's1',
      cwd: '/repo',
      apis: [echoApi('runner'), echoApi('other')],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect(server.socketPath).toBe(path.join(dir, 'api.sock'));
    expect(fs.existsSync(server.socketPath!)).toBe(true);
    // The mount prefix is stripped, so a package declares routes relative to itself.
    expect(await request(server.socketPath!, '/api/plugin/runner/runners/r1/log')).toEqual({
      status: 200,
      body: JSON.stringify({ basePath: 'runner', path: '/runners/r1/log' }),
    });
    expect(JSON.parse((await request(server.socketPath!, '/api/plugin/other/x')).body)).toMatchObject({
      basePath: 'other',
    });
  });

  it('tells an API which session it is serving', async () => {
    const seen: { context?: DoomApiContext } = {};
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      internalToken: 'agent-only-token',
      apis: [echoApi('runner', seen)],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect(seen.context).toMatchObject({
      scope: 'session',
      sessionId: 's1',
      cwd: '/repo',
      internalToken: 'agent-only-token',
    });
  });

  it('opens no socket at all when no package declares an API', async () => {
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect(server.socketPath).toBeUndefined();
  });

  it('answers 404 for a base path no package claims', async () => {
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [echoApi('runner')],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect((await request(server.socketPath!, '/api/plugin/absent/x')).status).toBe(404);
    expect((await request(server.socketPath!, '/elsewhere')).status).toBe(404);
  });

  it('contains an API that throws, and keeps serving the others', async () => {
    const notices: string[] = [];
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [
        {
          basePath: 'boom',
          start: () => ({
            fetch: () => {
              throw new Error('the package fell over');
            },
            close: () => undefined,
          }),
        },
        echoApi('runner'),
      ],
      onNotice: (message) => notices.push(message),
    });
    cleanups.push(() => server.close());

    expect((await request(server.socketPath!, '/api/plugin/boom/x')).status).toBe(500);
    expect(notices.join('\n')).toMatch(/'boom' failed/u);
    expect((await request(server.socketPath!, '/api/plugin/runner/x')).status).toBe(200);
  });

  it('reports an API that will not start, and mounts the rest', async () => {
    const notices: string[] = [];
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [
        {
          basePath: 'bad',
          start: () => {
            throw new Error('nope');
          },
        },
        echoApi('runner'),
      ],
      onNotice: (message) => notices.push(message),
    });
    cleanups.push(() => server.close());

    expect(notices.join('\n')).toMatch(/'bad' did not start/u);
    expect((await request(server.socketPath!, '/api/plugin/runner/x')).status).toBe(200);
  });

  it('records package API completion after a streamed body ends', async () => {
    const spans: string[] = [];
    const telemetry = {
      runInSpan: async <T>(name: string, _attributes: Record<string, unknown>, callback: () => Promise<T> | T) => {
        spans.push(name);
        return callback();
      },
    } as unknown as ServerTelemetry;
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      telemetry,
      apis: [
        {
          basePath: 'stream',
          start: () => ({
            fetch: () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('done'));
                    controller.close();
                  },
                }),
              ),
            close: () => undefined,
          }),
        },
      ],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect(await request(server.socketPath!, '/api/plugin/stream/read')).toEqual({ status: 200, body: 'done' });
    expect(spans).toEqual(['doompi_server.package_api.request', 'doompi_server.package_api.complete']);
  });

  it('removes its socket when it closes, so a relaunch is not blocked by a stale one', async () => {
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [echoApi('runner')],
      onNotice: () => undefined,
    });
    const socketPath = server.socketPath!;

    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
