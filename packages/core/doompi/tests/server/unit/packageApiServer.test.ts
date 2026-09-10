import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DoomApi, DoomApiContext } from '@agimon-ai/doompi-extension-contracts/package-api';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { serveSessionApis } from '../../../src/adapters/server/packageApiServer.ts';
import type { ServerTelemetry } from '../../../src/adapters/server/serverTelemetry.ts';

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
      hubToken: 'hub-only-token',
      apis: [echoApi('runner', seen)],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect(seen.context).toMatchObject({
      scope: 'session',
      sessionId: 's1',
      cwd: '/repo',
      internalToken: 'agent-only-token',
      hubToken: 'hub-only-token',
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

  // A fast success is fully described by the request span, so the completion span is skipped.
  // Emitting both per call made package API traffic 99.65% of all recorded spans.
  it('skips the completion span for a fast successful streamed body', async () => {
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
    expect(spans).toEqual(['doompi_server.package_api.request']);
  });

  // A failing status is exactly the case the completion span exists for: the request span ends
  // at headers and never learns the status code.
  it('records package API completion when the response fails', async () => {
    const spans: string[] = [];
    const attributes: Array<Record<string, unknown>> = [];
    const telemetry = {
      runInSpan: async <T>(name: string, spanAttributes: Record<string, unknown>, callback: () => Promise<T> | T) => {
        spans.push(name);
        attributes.push(spanAttributes);
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
            fetch: () => Response.json({ error: 'nope' }, { status: 503 }),
            close: () => undefined,
          }),
        },
      ],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect((await request(server.socketPath!, '/api/plugin/stream/read')).status).toBe(503);
    expect(spans).toEqual(['doompi_server.package_api.request', 'doompi_server.package_api.complete']);
    expect(attributes.at(-1)).toMatchObject({ status_code: 503 });
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
  it('serves an API a session server facet registers', async () => {
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [],
      facets: [
        {
          inject: [DOOM_SERVER_HOST_SERVICE],
          apply(context) {
            const host = context.get(DOOM_SERVER_HOST_SERVICE);
            if (!host || host.scope !== 'session') return undefined;
            const registration = host.registerApi(echoApi('runner'));
            return () => registration.dispose();
          },
        },
      ],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    const response = await request(server.socketPath!, '/api/plugin/runner/log');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ path: '/log' });
  });
  it('installs an attributed server bundle facet before serving its API', async () => {
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [],
      facets: [
        {
          declaration: {
            packageName: 'runner',
            entry: './src/exports/extensions/server.ts',
            module: './modules/runner.mjs',
            scopes: ['session'] as const,
            owners: [{ majorMode: 'coding', layer: 'tools' }],
            required: false,
          },
          facet: {
            inject: [DOOM_SERVER_HOST_SERVICE],
            apply(context) {
              const host = context.get(DOOM_SERVER_HOST_SERVICE);
              if (!host || host.scope !== 'session') return undefined;
              const registration = host.registerApi(echoApi('runner'));
              return () => registration.dispose();
            },
          },
        },
      ],
      onNotice: () => undefined,
    });
    cleanups.push(() => server.close());

    expect((await request(server.socketPath!, '/api/plugin/runner/log')).status).toBe(200);
  });

  it('keeps the legacy API as the first owner during dual registration', async () => {
    const notices: string[] = [];
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [echoApi('shared')],
      facets: [
        {
          inject: [DOOM_SERVER_HOST_SERVICE],
          apply(context) {
            const host = context.get(DOOM_SERVER_HOST_SERVICE);
            if (!host) return undefined;
            const registration = host.registerApi({
              basePath: 'shared',
              start: () => ({ fetch: () => Response.json({ owner: 'facet' }), close: () => undefined }),
            });
            return () => registration.dispose();
          },
        },
      ],
      onNotice: (message) => notices.push(message),
    });
    cleanups.push(() => server.close());

    expect(JSON.parse((await request(server.socketPath!, '/api/plugin/shared/status')).body)).toMatchObject({
      basePath: 'shared',
    });
    expect(notices.join('\n')).toMatch(/another facet already claims it/u);
  });

  it('isolates a throwing facet and still serves a healthy sibling', async () => {
    const notices: string[] = [];
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [],
      facets: [
        {
          inject: [DOOM_SERVER_HOST_SERVICE],
          apply() {
            throw new Error('facet failed');
          },
        },
        {
          inject: [DOOM_SERVER_HOST_SERVICE],
          apply(context) {
            const host = context.get(DOOM_SERVER_HOST_SERVICE);
            if (!host) return undefined;
            const registration = host.registerApi(echoApi('healthy'));
            return () => registration.dispose();
          },
        },
      ],
      onNotice: (message) => notices.push(message),
    });
    cleanups.push(() => server.close());

    expect(notices.join('\n')).toMatch(/server facet did not install.*facet failed/u);
    expect((await request(server.socketPath!, '/api/plugin/healthy/status')).status).toBe(200);
  });

  it('closes facet handlers and runs facet disposers on shutdown', async () => {
    const handlerClose = vi.fn();
    const facetDispose = vi.fn();
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [],
      facets: [
        {
          inject: [DOOM_SERVER_HOST_SERVICE],
          apply(context) {
            const host = context.get(DOOM_SERVER_HOST_SERVICE);
            if (!host) return undefined;
            const registration = host.registerApi({
              basePath: 'owned',
              start: () => ({ fetch: () => Response.json({ ok: true }), close: handlerClose }),
            });
            return () => {
              facetDispose();
              registration.dispose();
            };
          },
        },
      ],
      onNotice: () => undefined,
    });
    const socketPath = server.socketPath!;

    await server.close();

    expect(facetDispose).toHaveBeenCalledOnce();
    expect(handlerClose).toHaveBeenCalledOnce();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('opens no socket when a facet registers nothing for this scope', async () => {
    const server = await serveSessionApis({
      socketDir: socketDir(),
      sessionId: 's1',
      cwd: '/repo',
      apis: [],
      facets: [
        {
          inject: [DOOM_SERVER_HOST_SERVICE],
          apply(context) {
            const host = context.get(DOOM_SERVER_HOST_SERVICE);
            return host?.scope === 'hub' ? () => undefined : undefined;
          },
        },
      ],
      onNotice: () => undefined,
    });

    expect(server.socketPath).toBeUndefined();
    await server.close();
  });
});
