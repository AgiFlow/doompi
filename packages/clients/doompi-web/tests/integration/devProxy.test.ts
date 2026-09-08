import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

// Proxy fixtures supply their own assets; never sync the developer's repositories or global config.
vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));

const SESSION = 'devproxy';

interface Upstream {
  port: number;
  seen: { method: string; url: string; host?: string; cookie?: string; prefix?: string }[];
  close: () => Promise<void>;
}

/** A stand-in for the developer's dev server: records what it was sent, answers what it is told to. */
async function startUpstream(handler: http.RequestListener, bindHost = '127.0.0.1'): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const server = http.createServer((request, response) => {
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      host: request.headers.host,
      cookie: request.headers.cookie,
      prefix: request.headers['x-forwarded-prefix'] as string | undefined,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, bindHost, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('upstream did not bind a port');
  return {
    port: address.port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let server: WebServer;
let session: FakeSession;
let registryDir: string;
let assetsDir: string;
let upstream: Upstream;

beforeEach(async () => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-devproxy-'));
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-devproxy-assets-'));
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
});

afterEach(async () => {
  await upstream?.close();
  await server?.close();
  await session?.close();
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

const url = (route: string): string => `${server.url}${route}`;

/** A GET whose path reaches the wire exactly as written, with no URL normalization. */
async function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  const target = new URL(server.url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: target.hostname, port: Number(target.port), path: rawPath, method: 'GET' },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function register(name: string, port: number): Promise<Response> {
  return fetch(url('/api/dev-proxy/targets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, port }),
  });
}

describe('dev proxy target registration', () => {
  beforeEach(async () => {
    upstream = await startUpstream((_request, response) => response.end('ok'));
  });

  it('registers a target and lists it', async () => {
    expect((await register('storefront', upstream.port)).status).toBe(201);
    const listed = (await (await fetch(url('/api/dev-proxy/targets'))).json()) as {
      targets: { name: string; port: number }[];
      canRegister: boolean;
    };
    expect(listed.targets).toHaveLength(1);
    expect(listed.targets[0]).toMatchObject({ name: 'storefront', port: upstream.port });
    expect(listed.canRegister).toBe(true);
  });

  it('refuses a port the cockpit itself is holding', async () => {
    const own = Number(new URL(server.url).port);
    const answer = await register('loop', own);
    expect(answer.status).toBe(400);
    expect((await answer.json()) as { error: string }).toMatchObject({
      error: 'That port belongs to the cockpit itself.',
    });
  });

  it('refuses a name that would not survive a path or a base option', async () => {
    expect((await register('Store Front', upstream.port)).status).toBe(400);
    expect((await register('', upstream.port)).status).toBe(400);
  });

  it('removes a target', async () => {
    await register('storefront', upstream.port);
    expect((await fetch(url('/api/dev-proxy/targets/storefront'), { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(url('/api/dev-proxy/targets/storefront'), { method: 'DELETE' })).status).toBe(404);
  });
});

describe('dev proxy forwarding', () => {
  beforeEach(async () => {
    upstream = await startUpstream((request, response) => {
      if (request.url === '/devproxy/storefront/redirect-me') {
        response.writeHead(302, { location: '/login' });
        response.end();
        return;
      }
      if (request.url === '/devproxy/storefront/set-cookie') {
        response.writeHead(200, { 'set-cookie': 'sid=abc; Path=/; HttpOnly' });
        response.end('cookie');
        return;
      }
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => response.end(`got ${String(Buffer.concat(chunks).length)}`));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`served ${request.url ?? ''}`);
    });
    await register('storefront', upstream.port);
  });

  it('passes the path through with its prefix, which is what a configured base expects', async () => {
    const answer = await fetch(url('/devproxy/storefront/@vite/client'));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe('served /devproxy/storefront/@vite/client');
  });

  it('preserves the query string', async () => {
    expect(await (await fetch(url('/devproxy/storefront/main.js?v=abc'))).text()).toBe(
      'served /devproxy/storefront/main.js?v=abc',
    );
  });

  it('keeps percent-encoding intact so an escaped filename resolves', async () => {
    expect(await (await fetch(url('/devproxy/storefront/a%20b.png'))).text()).toBe(
      'served /devproxy/storefront/a%20b.png',
    );
  });

  it('rewrites Host to the upstream, which is what Vite allowedHosts checks', async () => {
    await fetch(url('/devproxy/storefront/'));
    expect(upstream.seen.at(-1)?.host).toBe(`127.0.0.1:${String(upstream.port)}`);
  });

  it('announces the mount so a framework that reads it can self-configure', async () => {
    await fetch(url('/devproxy/storefront/'));
    expect(upstream.seen.at(-1)?.prefix).toBe('/devproxy/storefront');
  });

  it("never hands the cockpit's session cookie to the dev server", async () => {
    await fetch(url('/devproxy/storefront/'), {
      headers: { cookie: '__Host-doompi_device=super-secret; theme=dark' },
    });
    const cookie = upstream.seen.at(-1)?.cookie;
    expect(cookie).toBe('theme=dark');
    expect(cookie).not.toContain('super-secret');
  });

  it('forwards a request body, which is what a form post needs', async () => {
    const answer = await fetch(url('/devproxy/storefront/submit'), { method: 'POST', body: 'hello world' });
    expect(await answer.text()).toBe('got 11');
  });

  it('keeps a root-relative redirect inside the proxied target', async () => {
    const answer = await fetch(url('/devproxy/storefront/redirect-me'), { redirect: 'manual' });
    expect(answer.headers.get('location')).toBe('/devproxy/storefront/login');
  });

  it("narrows the dev app's cookie path so it stays out of the cockpit", async () => {
    const answer = await fetch(url('/devproxy/storefront/set-cookie'));
    expect(answer.headers.get('set-cookie')).toContain('Path=/devproxy/storefront/');
  });

  it('redirects a bare target to its trailing slash', async () => {
    const answer = await fetch(url('/devproxy/storefront'), { redirect: 'manual' });
    expect(answer.status).toBe(301);
    expect(answer.headers.get('location')).toBe('/devproxy/storefront/');
  });

  it('never lets a climbing path reach the dev server or the API', async () => {
    // Sent down a raw socket on purpose: a browser and Node's own fetch both
    // resolve `..` before the request leaves, so going through fetch would
    // test the URL parser rather than the proxy. Anything that is not a
    // browser can put these on the wire verbatim.
    //
    // The assertion is about where the bytes end up, not the status code. Dot
    // segments are resolved by `new URL` before this handler reads the path,
    // so such a request stops being a proxy request somewhere in the stack;
    // what matters is that it neither reaches the dev server nor gets served
    // as an API call that skipped the sealed gateway.
    for (const climbing of [
      '/devproxy/storefront/%2e%2e/%2e%2e/api/sessions',
      '/devproxy/storefront/../../api/sessions',
    ]) {
      const answer = await rawGet(climbing);
      expect(answer.status).not.toBe(200);
    }
    expect(upstream.seen.some((entry) => entry.url.includes('api/sessions'))).toBe(false);
    expect(upstream.seen.some((entry) => entry.url.includes('..'))).toBe(false);
  });

  /**
   * The target is configured with `base: '/devproxy/<name>/'` and redirects
   * anything at its root back there. A proxy that stripped the prefix would
   * hand it `/`, take that redirect, strip again, and loop until the browser
   * gave up. Real Vite does exactly this.
   */
  it('does not loop against a dev server that redirects its root to the base', async () => {
    const based = await startUpstream((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { location: '/devproxy/based/' });
        response.end();
        return;
      }
      response.end('based');
    });
    try {
      await register('based', based.port);
      const answer = await fetch(url('/devproxy/based/'));
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe('based');
      expect(based.seen.at(-1)?.url).toBe('/devproxy/based/');
    } finally {
      await based.close();
    }
  });

  it('answers 404 for a target that was never registered', async () => {
    expect((await fetch(url('/devproxy/ghost/'))).status).toBe(404);
  });

  it('explains an upstream that is not listening instead of hanging', async () => {
    await register('dead', 1);
    const answer = await fetch(url('/devproxy/dead/'));
    expect(answer.status).toBe(502);
    expect(await answer.text()).toContain('Nothing is answering on 127.0.0.1:1');
  });

  it('leaves the cockpit shell reachable while a target is registered', async () => {
    expect((await fetch(url('/api/dev-proxy/targets'))).status).toBe(200);
    expect(upstream.seen.some((entry) => entry.url.startsWith('/api/'))).toBe(false);
  });

  /**
   * Vite binds `localhost`, which on a dual-stack machine is `::1` and not
   * `127.0.0.1`. A proxy that only ever dialled the IPv4 literal would refuse
   * every connection to a default Vite dev server.
   */
  it('reaches a dev server listening only on IPv6 loopback', async () => {
    const sixOnly = await startUpstream((_request, response) => response.end('v6'), '::1');
    try {
      await register('sixish', sixOnly.port);
      const answer = await fetch(url('/devproxy/sixish/'));
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe('v6');
      expect(sixOnly.seen.at(-1)?.url).toBe('/devproxy/sixish/');
      expect(sixOnly.seen.at(-1)?.host).toBe(`[::1]:${String(sixOnly.port)}`);
    } finally {
      await sixOnly.close();
    }
  });

  it('does not answer a lookalike prefix', async () => {
    const answer = await fetch(url('/devproxyevil/storefront/'), { redirect: 'manual' });
    expect(answer.status).not.toBe(200);
    expect(upstream.seen.some((entry) => entry.url.includes('storefront'))).toBe(false);
  });
});
