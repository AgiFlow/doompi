import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PiClient } from '@earendil-works/pi-client';
import type { ByteTransport, ByteTransportHandlers } from '@earendil-works/pi-client';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { serveWeb } from '../../src/adapters/httpServer.ts';
import type { WebServer } from '../../src/types/bridge.ts';
import { connectSealedChannel } from '@agimon-ai/doompi-web-security/browser';
import type { TunnelConfig, TunnelStartResult } from '../../src/types/remoteAccess.ts';
import { type FakeSession, startFakeSession } from '../support/fakeSession.ts';

vi.mock('../../src/adapters/syncGuard.ts', () => ({
  createSyncGuard: () => ({
    ensureSynced: async () => undefined,
    watch: () => undefined,
    close: () => undefined,
  }),
}));

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
    verifyRegistrationResponse: vi.fn(actual.verifyRegistrationResponse),
  };
});

const SESSION = 'remote';
const UNAUTHORIZED = 401;

let server: WebServer;
let session: FakeSession;
let registryDir: string;
let stateDir: string;
let tunnelPort: number | undefined;
let stopped: number;

/**
 * A tunnel that publishes the loopback listener under its own address.
 *
 * Reporting `http://127.0.0.1:<port>` as the public origin means Host and
 * Origin line up when a test connects directly, so the guard runs its real
 * comparisons rather than a relaxed variant written for the test.
 */
async function fakeTunnel(input: { port: number; config: TunnelConfig }): Promise<TunnelStartResult> {
  tunnelPort = input.port;
  return {
    ok: true,
    publicOrigin:
      input.config.kind === 'named' ? `https://${input.config.hostname}` : `http://127.0.0.1:${String(input.port)}`,
    stop: async () => {
      stopped += 1;
    },
  };
}

function localUrl(route: string): string {
  return `${server.url}${route}`;
}

function tunnelOrigin(): string {
  return `http://127.0.0.1:${String(tunnelPort)}`;
}

function tunnelUrl(route: string): string {
  return `${tunnelOrigin()}${route}`;
}

function rawTunnelFetch(
  route: string,
  input: { method: string; headers: Record<string, string>; body: string },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(tunnelUrl(route), { method: input.method, headers: input.headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('end', () => {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index] ?? '', incoming.rawHeaders[index + 1] ?? '');
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status: incoming.statusCode ?? 500,
            headers,
          }),
        );
      });
    });
    request.once('error', reject);
    request.end(input.body);
  });
}

async function enable(): Promise<void> {
  const response = await fetch(localUrl('/api/remote/enable'), { method: 'POST' });
  expect(response.status).toBe(200);
}

/** Runs the whole scan-approve-redeem handshake and returns the session cookie. */
async function pair(): Promise<string> {
  const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
  expect(minted.status).toBe(201);
  const { code } = (await minted.json()) as { code: string };

  const claimed = await fetch(tunnelUrl('/api/remote/pair'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
    body: JSON.stringify({ code }),
  });
  expect(claimed.status).toBe(202);
  const { requestId } = (await claimed.json()) as { requestId: string };

  const approved = await fetch(localUrl(`/api/remote/pairing/${requestId}/approve`), { method: 'POST' });
  expect(approved.status).toBe(200);

  const status = await fetch(tunnelUrl(`/api/remote/pair/status?request=${requestId}`), {
    headers: { origin: tunnelOrigin() },
  });
  expect(await status.json()).toEqual({ status: 'approved' });
  const setCookie = status.headers.get('set-cookie');
  if (setCookie === null) throw new Error('The approval did not set a session cookie.');
  return setCookie;
}

function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

/** Completes one scoped exchange the cockpit bundle would, and returns the client half. */
async function openChannel(cookie: string, scope: 'session' | 'protocol' | 'http' = 'session') {
  const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
  const { pairUrl } = (await minted.json()) as { pairUrl: string };
  const hostKey = new URLSearchParams(new URL(pairUrl).hash.slice(1)).get('k');
  if (hostKey === null) throw new Error('the pairing URL had no host key');
  const connected = await connectSealedChannel(hostKey);
  if (connected === undefined) throw new Error('the browser half refused the handshake');
  const accepted = await fetch(tunnelUrl('/api/remote/channel'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: tunnelOrigin(), cookie },
    body: JSON.stringify({ scope, clientPublicKey: connected.clientPublicKey }),
  });
  expect(accepted.status).toBe(200);
  return connected.channel;
}

/** Runs Pi's binary protocol through the same sealed tunnel transport as the browser. */
function sealedProtocolTransport(
  url: string,
  headers: Record<string, string>,
  channel: Awaited<ReturnType<typeof openChannel>>,
) {
  return async (handlers: ByteTransportHandlers): Promise<ByteTransport> => {
    const socket = new WebSocket(url, { headers });
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
      socket.once('unexpected-response', (_request, response) => {
        reject(new Error(`The protocol upgrade answered ${String(response.statusCode)}.`));
      });
    });
    let incoming = Promise.resolve();
    socket.on('message', (data: ArrayBuffer | Buffer) => {
      incoming = incoming
        .then(async () => {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
          const envelope: unknown = JSON.parse(new TextDecoder().decode(bytes));
          const opened = await channel.open(envelope);
          if (!opened.ok) throw new Error(opened.failure);
          handlers.onData(opened.plaintext);
        })
        .catch((error: unknown) => handlers.onError(error instanceof Error ? error : new Error(String(error))));
    });
    socket.on('close', () => handlers.onClose());
    socket.on('error', (error: Error) => handlers.onError(error));
    return {
      async send(chunk) {
        const sealed = await channel.seal(chunk);
        if (!sealed.ok) throw new Error(sealed.failure);
        const bytes = new TextEncoder().encode(JSON.stringify(sealed.envelope));
        await new Promise<void>((resolve, reject) => {
          socket.send(bytes, (error) => (error ? reject(error) : resolve()));
        });
      },
      close: () => socket.close(),
    };
  };
}
async function sealedFetch(cookie: string, target: string, init: RequestInit = {}): Promise<Response> {
  const channel = await openChannel(cookie, 'http');
  const body = typeof init.body === 'string' ? Buffer.from(init.body).toString('base64') : undefined;
  const sealed = await channel.seal(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        method: (init.method ?? 'GET').toUpperCase(),
        target,
        headers: Array.from(new Headers(init.headers).entries()),
        ...(body === undefined ? {} : { body }),
      }),
    ),
  );
  if (!sealed.ok) throw new Error(sealed.failure);
  const outer = await fetch(tunnelUrl('/api/remote/request'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: tunnelOrigin(), cookie },
    body: JSON.stringify(sealed.envelope),
  });
  if (!outer.ok) throw new Error(`sealed HTTP gateway answered ${String(outer.status)}: ${await outer.text()}`);
  const opened = await channel.open(await outer.json());
  if (!opened.ok) throw new Error(opened.failure);
  const response = JSON.parse(new TextDecoder().decode(opened.plaintext)) as {
    status: number;
    headers: Array<[string, string]>;
    body: string;
  };
  const responseBody = Buffer.from(response.body, 'base64');
  return new Response(
    response.status === 204 || response.status === 205 || response.status === 304 ? null : responseBody,
    {
      status: response.status,
      headers: response.headers,
    },
  );
}

beforeEach(async () => {
  tunnelPort = undefined;
  stopped = 0;
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-remote-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-state-'));
  session = await startFakeSession({ id: SESSION, registryDir, cwd: process.cwd() });
  server = await serveWeb({
    registryDir,
    spawnCommand: path.join(registryDir, 'no-such-server'),
    port: 0,
    assetsDir: '/nonexistent-assets',
    remoteStateDir: stateDir,
    remoteAccess: { launchTunnel: fakeTunnel },
  });
});

afterEach(async () => {
  await server.close();
  await session.close();
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('while remote access is off', () => {
  it('binds no second listener and changes nothing locally', async () => {
    expect(tunnelPort).toBeUndefined();
    const response = await fetch(localUrl('/api/health'));
    expect(response.status).toBe(200);
  });
});

describe('the tunnel listener refuses everything unpaired', () => {
  beforeEach(enable);

  it.each([
    ['GET', '/api/health'],
    ['GET', '/api/directories?q=/'],
    ['GET', '/api/sessions/remote/files'],
    ['GET', '/api/auth/providers'],
    ['GET', '/api/plugin/anything'],
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/favicon.ico'],
    ['GET', '/api/remote'],
  ])('answers 401 to %s %s', async (method, route) => {
    const response = await fetch(tunnelUrl(route), { method, headers: { origin: tunnelOrigin() } });
    expect(response.status).toBe(UNAUTHORIZED);
  });

  it('answers 401 to a session spawn', async () => {
    const response = await fetch(tunnelUrl('/api/sessions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    expect(response.status).toBe(UNAUTHORIZED);
  });

  it.each(['/api/session', '/api/pi'])('refuses the %s upgrade', async (route) => {
    const socket = new WebSocket(`${tunnelOrigin().replace('http', 'ws')}${route}`, {
      headers: { origin: tunnelOrigin() },
    });
    const status = await new Promise<number | 'open'>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 5000);
      socket.on('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        socket.terminate();
        resolve(response.statusCode ?? 0);
      });
      socket.on('open', () => {
        clearTimeout(timer);
        socket.close();
        resolve('open');
      });
      socket.on('error', () => undefined);
    });
    expect(status).toBe(UNAUTHORIZED);
  });

  it('serves the pairing page, and only the pairing page', async () => {
    const page = await fetch(tunnelUrl('/pair'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('doompi-pairing-page');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it.each(['/pair/', '/pairx', '//pair', '/PAIR', '/pair/../api/health'])(
    'does not let %s slip past the allowlist',
    async (route) => {
      const response = await fetch(tunnelUrl(route), { headers: { origin: tunnelOrigin() } });
      expect(response.status).toBe(UNAUTHORIZED);
    },
  );

  it('routes a percent-encoded pairing path the same way the guard reads it', async () => {
    const response = await fetch(tunnelUrl('/%70air'));
    expect(response.status).toBe(200);
  });
});

describe('pairing', () => {
  beforeEach(enable);

  it('needs the host to approve, not just the scan', async () => {
    const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
    const { code } = (await minted.json()) as { code: string };
    const claimed = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ code }),
    });
    const { requestId } = (await claimed.json()) as { requestId: string };
    const status = await fetch(tunnelUrl(`/api/remote/pair/status?request=${requestId}`), {
      headers: { origin: tunnelOrigin() },
    });
    expect(await status.json()).toEqual({ status: 'pending' });
    expect(status.headers.get('set-cookie')).toBeNull();
  });

  it('refuses an unpaired device that tries to approve itself', async () => {
    const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
    const { code } = (await minted.json()) as { code: string };
    const claimed = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ code }),
    });
    const { requestId } = (await claimed.json()) as { requestId: string };
    // Refused by the guard before the route is reached, because an unpaired
    // caller has no business anywhere outside the three pairing endpoints.
    const selfApproved = await fetch(tunnelUrl(`/api/remote/pairing/${requestId}/approve`), {
      method: 'POST',
      headers: { origin: tunnelOrigin() },
    });
    expect(selfApproved.status).toBe(UNAUTHORIZED);
  });

  it('refuses a paired device that tries to approve another one', async () => {
    // The escalation that matters: a phone that can approve devices can make
    // its own access permanent, which is exactly what host confirmation is for.
    const cookie = cookieValue(await pair());
    const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
    const { code } = (await minted.json()) as { code: string };
    const claimed = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ code }),
    });
    const { requestId } = (await claimed.json()) as { requestId: string };

    const byPhone = await sealedFetch(cookie, `/api/remote/pairing/${requestId}/approve`, { method: 'POST' });
    expect(byPhone.status).toBe(403);

    // And it cannot mint a code to start one either.
    const minting = await sealedFetch(cookie, '/api/remote/codes', { method: 'POST' });
    expect(minting.status).toBe(403);
  });

  it('lets a paired device pull the panic switch', async () => {
    // Deliberately the one control-plane action a phone keeps: turning remote
    // access off is worth more from the couch than from the desk.
    const cookie = cookieValue(await pair());
    const response = await sealedFetch(cookie, '/api/remote/disable', { method: 'POST' });
    // Answered before the teardown, so the caller learns it worked rather than
    // seeing the socket vanish under the response.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'closing' });
    await vi.waitFor(() => {
      expect(stopped).toBe(1);
    });
  });

  it('sets a cookie that is Secure and host-prefixed even over plaintext', async () => {
    // cloudflared terminates TLS at the edge, so the request here is http. The
    // attributes are constants rather than anything derived from the request.
    const setCookie = await pair();
    expect(setCookie).toContain('__Host-doompi_device=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain');
  });

  it('opens every route once paired through a sealed HTTP channel', async () => {
    const cookie = cookieValue(await pair());
    const response = await sealedFetch(cookie, '/api/health');
    expect(response.status).toBe(200);
  });

  it('gives a stolen session cookie no API or socket access without the host key', async () => {
    const cookie = cookieValue(await pair());
    const direct = await fetch(tunnelUrl('/api/health'), {
      headers: { cookie, origin: tunnelOrigin() },
    });
    expect(direct.status).toBe(UNAUTHORIZED);

    for (const route of ['/api/session', '/api/pi']) {
      const socket = new WebSocket(`${tunnelOrigin().replace('http', 'ws')}${route}`, {
        headers: { cookie, origin: tunnelOrigin() },
      });
      const status = await new Promise<number | 'open'>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer for ${route}`)), 5000);
        socket.on('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
        socket.on('open', () => {
          clearTimeout(timer);
          socket.close();
          resolve('open');
        });
        socket.on('error', () => undefined);
      });
      expect(status, route).toBe(UNAUTHORIZED);
    }
  });

  it('opens the session socket once paired', async () => {
    const cookie = cookieValue(await pair());
    await openChannel(cookie);
    const socket = new WebSocket(`${tunnelOrigin().replace('http', 'ws')}/api/session`, {
      headers: { cookie, origin: tunnelOrigin() },
    });
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      socket.on('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      socket.on('unexpected-response', () => {
        clearTimeout(timer);
        resolve(false);
      });
      socket.on('error', () => undefined);
    });
    socket.close();
    expect(opened).toBe(true);
  });

  it('refuses a redeemed request a second time', async () => {
    const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
    const { code } = (await minted.json()) as { code: string };
    const claimed = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ code }),
    });
    const { requestId } = (await claimed.json()) as { requestId: string };
    await fetch(localUrl(`/api/remote/pairing/${requestId}/approve`), { method: 'POST' });
    await fetch(tunnelUrl(`/api/remote/pair/status?request=${requestId}`), { headers: { origin: tunnelOrigin() } });
    const second = await fetch(tunnelUrl(`/api/remote/pair/status?request=${requestId}`), {
      headers: { origin: tunnelOrigin() },
    });
    expect(await second.json()).toEqual({ status: 'consumed' });
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a replayed code', async () => {
    const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
    const { code } = (await minted.json()) as { code: string };
    const body = JSON.stringify({ code });
    const headers = { 'content-type': 'application/json', origin: tunnelOrigin() };
    await fetch(tunnelUrl('/api/remote/pair'), { method: 'POST', headers, body });
    const replay = await fetch(tunnelUrl('/api/remote/pair'), { method: 'POST', headers, body });
    expect(replay.status).toBe(410);
  });

  it.each([
    ['/api/remote/pair', `${'{"code":"'}${'x'.repeat(2048)}"}`],
    ['/api/remote/passkeys/authenticate/begin', JSON.stringify({ padding: 'x'.repeat(256) })],
    ['/api/remote/passkeys/authenticate/finish', JSON.stringify({ response: { padding: 'x'.repeat(64 * 1024) } })],
  ])('rejects an oversized public JSON body on %s', async (route, body) => {
    const response = await fetch(tunnelUrl(route), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body,
    });
    expect(response.status).toBe(413);
  });

  it('bounds concurrent public request bodies', async () => {
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const held = Array.from({ length: 8 }, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(encoder.encode('{"code":"'));
        },
      });
      return fetch(tunnelUrl('/api/remote/pair'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }).catch(() => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const overflow = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ code: 'wrong' }),
    });
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('retry-after')).toBe('1');

    for (const controller of controllers) controller.close();
    await Promise.all(held);
  });
  it('uses Cloudflare client addresses independently and ignores generic forwarding headers', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await fetch(tunnelUrl('/api/remote/pair'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: tunnelOrigin(),
          'cf-connecting-ip': '198.51.100.1',
          'x-forwarded-for': `198.51.100.${String(attempt + 10)}`,
        },
        body: JSON.stringify({ code: 'wrong' }),
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 410));
    expect(statuses[10]).toBe(429);
    const otherSource = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: tunnelOrigin(),
        'cf-connecting-ip': '198.51.100.2',
      },
      body: JSON.stringify({ code: 'wrong' }),
    });
    expect(otherSource.status).toBe(410);
    expect(stopped).toBe(0);
    expect((await fetch(tunnelUrl('/pair'))).status).toBe(200);
  });
});

describe('step-up on the escalation paths', () => {
  beforeEach(enable);

  it('does not gate anything on a quick tunnel, which has no passkeys', async () => {
    // A rotating hostname cannot carry a passkey, so there is no second factor
    // to demand and pretending otherwise would just lock the phone out.
    const cookie = cookieValue(await pair());
    const response = await sealedFetch(cookie, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 400 for the empty body: the guard let it reach the handler.
    expect(response.status).toBe(400);
  });

  it('leaves ordinary agent work ungated', async () => {
    const cookie = cookieValue(await pair());
    const response = await sealedFetch(cookie, '/api/health');
    expect(response.status).toBe(200);
  });
});

describe('the sealed channel', () => {
  beforeEach(enable);

  it('puts the host key in the QR fragment, never in the query', async () => {
    const minted = await fetch(localUrl('/api/remote/codes'), { method: 'POST' });
    const { pairUrl } = (await minted.json()) as { pairUrl: string };
    const url = new URL(pairUrl);
    expect(url.search).toBe('');
    expect(url.hash).toContain('k=');
    expect(url.hash).toContain('c=');
  });

  it('carries socket frames as ciphertext once the channel is open', async () => {
    const cookie = cookieValue(await pair());
    const channel = await openChannel(cookie);

    const socket = new WebSocket(`${tunnelOrigin().replace('http', 'ws')}/api/session`, {
      headers: { cookie, origin: tunnelOrigin() },
    });
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame arrived')), 5000);
      socket.on('message', (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      socket.on('error', reject);
    });
    socket.close();

    // Nothing legible on the wire: a relay sees an envelope, not a hub hello.
    expect(raw).not.toContain('hub_hello');
    const opened = await channel.open(JSON.parse(raw));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toMatchObject({ type: 'hub_hello' });
  });

  it('leaves the loopback listener in plaintext, where there is no relay to keep out', async () => {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/session`);
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame arrived')), 5000);
      socket.on('message', (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      socket.on('error', reject);
    });
    socket.close();
    expect(JSON.parse(raw)).toMatchObject({ type: 'hub_hello' });
  });

  it('refuses a channel key from a device with no session', async () => {
    const response = await fetch(tunnelUrl('/api/remote/channel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ scope: 'session', clientPublicKey: 'anything' }),
    });
    expect(response.status).toBe(UNAUTHORIZED);
  });

  it('refuses a key that is not a point on the curve', async () => {
    const cookie = cookieValue(await pair());
    const response = await fetch(tunnelUrl('/api/remote/channel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin(), cookie },
      body: JSON.stringify({ scope: 'session', clientPublicKey: 'bm90LWEta2V5' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('switching remote access off', () => {
  beforeEach(enable);

  it('stops the tunnel and revokes the paired session', async () => {
    const cookie = cookieValue(await pair());
    const port = tunnelPort;
    await fetch(localUrl('/api/remote/disable'), { method: 'POST' });
    expect(stopped).toBe(1);

    await enable();
    // The listener is rebound, so the old cookie is tried against a live
    // tunnel rather than a closed port: this asserts revocation, not absence.
    expect(tunnelPort).not.toBe(port);
    const response = await fetch(tunnelUrl('/api/health'), { headers: { cookie, origin: tunnelOrigin() } });
    expect(response.status).toBe(UNAUTHORIZED);
  });

  it('closes a live remote socket rather than leaving it driving the agent', async () => {
    const cookie = cookieValue(await pair());
    await openChannel(cookie);
    const socket = new WebSocket(`${tunnelOrigin().replace('http', 'ws')}/api/session`, {
      headers: { cookie, origin: tunnelOrigin() },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await fetch(localUrl('/api/remote/disable'), { method: 'POST' });
    await expect(closed).resolves.toBe(1008);
  });
});

describe('when the tunnel will not come up', () => {
  it('reports the reason and binds nothing', async () => {
    await server.close();
    server = await serveWeb({
      registryDir,
      spawnCommand: path.join(registryDir, 'no-such-server'),
      port: 0,
      assetsDir: '/nonexistent-assets',
      remoteStateDir: stateDir,
      remoteAccess: {
        launchTunnel: async () => ({
          ok: false,
          failure: 'not_installed',
          message: 'cloudflared is not installed.',
        }),
      },
    });

    const response = await fetch(localUrl('/api/remote/enable'), { method: 'POST' });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('not installed');

    const state = await fetch(localUrl('/api/remote'));
    const body = (await state.json()) as { state: { status: string; error?: string; publicUrl?: string } };
    expect(body.state.status).toBe('failed');
    // Nothing half-open: a failed start leaves no listener behind it.
    expect(body.state.publicUrl).toBeUndefined();
  });

  it('lets a second attempt succeed after a failure', async () => {
    let attempt = 0;
    await server.close();
    server = await serveWeb({
      registryDir,
      spawnCommand: path.join(registryDir, 'no-such-server'),
      port: 0,
      assetsDir: '/nonexistent-assets',
      remoteStateDir: stateDir,
      remoteAccess: {
        launchTunnel: async (input) => {
          attempt += 1;
          if (attempt === 1) return { ok: false, failure: 'timeout', message: 'no URL' };
          return await fakeTunnel(input);
        },
      },
    });

    expect((await fetch(localUrl('/api/remote/enable'), { method: 'POST' })).status).toBe(502);
    expect((await fetch(localUrl('/api/remote/enable'), { method: 'POST' })).status).toBe(200);
  });
});

describe('passkeys', () => {
  beforeEach(enable);

  it('reports itself unavailable on a quick tunnel, with the reason', async () => {
    // A rotating hostname cannot carry a passkey, and saying so beats letting
    // the ceremony fail in the browser.
    const response = await fetch(localUrl('/api/remote/passkeys'));
    const body = (await response.json()) as { support: { supported: boolean; reason?: string }; credentials: [] };
    expect(body.support.supported).toBe(false);
    expect(body.support.reason).toBeTruthy();
    expect(body.credentials).toEqual([]);
  });

  it('refuses to start a registration a quick tunnel cannot finish', async () => {
    const response = await fetch(localUrl('/api/remote/passkeys/register/begin'), { method: 'POST' });
    expect(response.status).toBe(409);
  });

  it('keeps enrolment on the host, because enrolling is granting access', async () => {
    const cookie = cookieValue(await pair());
    for (const route of ['/api/remote/passkeys/register/begin', '/api/remote/passkeys/register/finish']) {
      const response = await sealedFetch(cookie, route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status, route).toBe(403);
    }
  });

  it('refuses to forget a passkey that is not registered', async () => {
    const response = await fetch(localUrl('/api/remote/passkeys/nope'), { method: 'DELETE' });
    expect(response.status).toBe(404);
  });

  it('refuses a challenge for an action it does not gate', async () => {
    const response = await fetch(localUrl('/api/remote/challenge'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'session.delete' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('passkey sign-in', () => {
  beforeEach(enable);

  it('is reachable without a session, because proving a passkey is how you get one', async () => {
    // Refused for a reason (no stable relying party on a quick tunnel) rather
    // than because the caller is unpaired.
    const response = await fetch(tunnelUrl('/api/remote/passkeys/authenticate/begin'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: '{}',
    });
    expect(response.status).toBe(409);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toContain('__Host-doompi_ceremony_caller=');

    const refreshed = await fetch(tunnelUrl('/api/remote/passkeys/authenticate/begin'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin(), cookie: cookie ?? '' },
      body: '{}',
    });
    expect(refreshed.status).toBe(409);
    expect(refreshed.headers.get('set-cookie')).toContain(cookie);
  });

  it('returns the fresh tunnel key after passkey sign-in and blocks protocol session creation', async () => {
    await fetch(localUrl('/api/remote/disable'), { method: 'POST' });
    const configured = await fetch(localUrl('/api/remote/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tunnel: { kind: 'named', hostname: 'doom.example.com' } }),
    });
    expect(configured.status).toBe(200);
    await enable();

    const registration = await fetch(localUrl('/api/remote/passkeys/register/begin'), { method: 'POST' });
    expect(registration.status).toBe(200);
    const registrationBody = (await registration.json()) as { ceremonyId: string };
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'passkey-credential',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: [],
        },
      },
    } as never);
    const registered = await fetch(localUrl('/api/remote/passkeys/register/finish'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Test phone' },
      body: JSON.stringify({ ceremonyId: registrationBody.ceremonyId, response: { id: 'passkey-credential' } }),
    });
    expect(registered.status).toBe(200);

    const namedHeaders = {
      'content-type': 'application/json',
      host: 'doom.example.com',
      origin: 'https://doom.example.com',
    };
    const begun = await rawTunnelFetch('/api/remote/passkeys/authenticate/begin', {
      method: 'POST',
      headers: namedHeaders,
      body: '{}',
    });
    expect(begun.status).toBe(200);
    const callerCookie = begun.headers.get('set-cookie')?.split(';')[0];
    const begunBody = (await begun.json()) as { ceremonyId: string };
    expect(callerCookie).toContain('__Host-doompi_ceremony_caller=');

    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    } as never);
    const finished = await rawTunnelFetch('/api/remote/passkeys/authenticate/finish', {
      method: 'POST',
      headers: { ...namedHeaders, cookie: callerCookie ?? '' },
      body: JSON.stringify({ ceremonyId: begunBody.ceremonyId, response: { id: 'passkey-credential' } }),
    });
    expect(finished.status).toBe(200);
    const finishBody = (await finished.json()) as { hostPublicKey: string };
    expect(finishBody.hostPublicKey).toBeTruthy();
    const deviceCookie = finished.headers.get('set-cookie');
    if (deviceCookie === null) throw new Error('Passkey sign-in did not set a device cookie.');

    const connected = await connectSealedChannel(finishBody.hostPublicKey);
    if (connected === undefined) throw new Error('The returned host key could not establish a channel.');
    const deviceSession = cookieValue(deviceCookie);
    const accepted = await rawTunnelFetch('/api/remote/channel', {
      method: 'POST',
      headers: { ...namedHeaders, cookie: deviceSession },
      body: JSON.stringify({ scope: 'protocol', clientPublicKey: connected.clientPublicKey }),
    });
    expect(accepted.status).toBe(200);

    const protocol = new PiClient({
      transportFactory: sealedProtocolTransport(
        `${tunnelOrigin().replace('http', 'ws')}/api/pi`,
        { host: namedHeaders.host, origin: namedHeaders.origin, cookie: deviceSession },
        connected.channel,
      ),
    });
    await protocol.connect();
    try {
      await expect(protocol.createSession({ cwd: process.cwd() })).rejects.toThrow(/Operation is not implemented/);
    } finally {
      await protocol.dispose();
    }
  });

  it('rate-limits public ceremony starts per Cloudflare source', async () => {
    const request = (source: string) =>
      fetch(tunnelUrl('/api/remote/passkeys/authenticate/begin'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: tunnelOrigin(),
          'cf-connecting-ip': source,
        },
        body: '{}',
      });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request('203.0.113.40')).status).toBe(409);
    }
    const limited = await request('203.0.113.40');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await request('203.0.113.41')).status).toBe(409);
  });

  it('refuses an assertion that verifies against nothing', async () => {
    const response = await fetch(tunnelUrl('/api/remote/passkeys/authenticate/finish'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: tunnelOrigin(),
        cookie: '__Host-doompi_ceremony_caller=AAAAAAAAAAAAAAAAAAAAAA',
      },
      body: JSON.stringify({ ceremonyId: 'missing', response: { id: 'nope' } }),
    });
    expect(response.status).toBe(UNAUTHORIZED);
  });

  it('refuses a sign-in whose body is not JSON', async () => {
    const response = await fetch(tunnelUrl('/api/remote/passkeys/authenticate/finish'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a channel request with no key', async () => {
    const cookie = cookieValue(await pair());
    const response = await fetch(tunnelUrl('/api/remote/channel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin(), cookie },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('bounds a chunked channel request before parsing it', async () => {
    const cookie = cookieValue(await pair());
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ padding: 'x'.repeat(5 * 1024) })));
        controller.close();
      },
    });
    const response = await fetch(tunnelUrl('/api/remote/channel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin(), cookie },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(413);
  });
});

describe('bad requests', () => {
  beforeEach(enable);

  it('refuses a claim whose body is not JSON', async () => {
    const response = await fetch(localUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses settings whose body is not JSON', async () => {
    const response = await fetch(localUrl('/api/remote/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a claim with no code', async () => {
    const response = await fetch(tunnelUrl('/api/remote/pair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: tunnelOrigin() },
      body: JSON.stringify({ code: '' }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a status poll naming no request', async () => {
    expect((await fetch(tunnelUrl('/api/remote/pair/status'))).status).toBe(400);
  });

  it('reports an unknown pairing request rather than inventing one', async () => {
    expect((await fetch(tunnelUrl('/api/remote/pair/status?request=nope'))).status).toBe(404);
    expect((await fetch(localUrl('/api/remote/pairing/nope/approve'), { method: 'POST' })).status).toBe(404);
    expect((await fetch(localUrl('/api/remote/pairing/nope/deny'), { method: 'POST' })).status).toBe(404);
  });

  it('refuses to revoke a device that is not paired', async () => {
    expect((await fetch(localUrl('/api/remote/devices/nope'), { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses to mint a code while remote access is off', async () => {
    await fetch(localUrl('/api/remote/disable'), { method: 'POST' });
    expect((await fetch(localUrl('/api/remote/codes'), { method: 'POST' })).status).toBe(409);
  });

  it('clamps a settings value out of range immediately, not at the next load', async () => {
    const response = await fetch(localUrl('/api/remote/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idleMinutes: 99_999, absoluteHours: 0 }),
    });
    const body = (await response.json()) as { settings: { idleMinutes: number; absoluteHours: number } };
    expect(body.settings).toMatchObject({ idleMinutes: 1440, absoluteHours: 1 });
  });

  it('ignores a settings field it does not recognise', async () => {
    const response = await fetch(localUrl('/api/remote/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { settings: Record<string, unknown> }).not.toHaveProperty('settings.nonsense');
  });
});

describe('settings', () => {
  it('persists a toggle across a hub restart', async () => {
    const updated = await fetch(localUrl('/api/remote/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoCloseEnabled: false, idleMinutes: 45 }),
    });
    expect(updated.status).toBe(200);
    await server.close();

    server = await serveWeb({
      registryDir,
      spawnCommand: path.join(registryDir, 'no-such-server'),
      port: 0,
      assetsDir: '/nonexistent-assets',
      remoteStateDir: stateDir,
      remoteAccess: { launchTunnel: fakeTunnel },
    });
    const state = await fetch(localUrl('/api/remote'));
    const body = (await state.json()) as { state: { settings: { autoCloseEnabled: boolean; idleMinutes: number } } };
    expect(body.state.settings).toMatchObject({ autoCloseEnabled: false, idleMinutes: 45 });
  });
});

describe('handing the cockpit over to a container', () => {
  /**
   * A cockpit that would move into a container, without one existing.
   *
   * The handover itself belongs to the launcher; what is verified here is the
   * part the server owns: that it answers before it signals, and that it names
   * the sessions the container will and will not be able to reach.
   */
  async function containedServer(workspaces: string[]) {
    const handovers: { settings: { sandbox: { workspaces: string[] } }; sessions: { id: string; cwd: string }[] }[] =
      [];
    const notices: string[] = [];
    await server.close();
    server = await serveWeb({
      registryDir,
      spawnCommand: path.join(registryDir, 'no-such-server'),
      port: 0,
      assetsDir: '/nonexistent-assets',
      remoteStateDir: stateDir,
      remoteAccess: { launchTunnel: fakeTunnel },
      onNotice: (message) => notices.push(message),
      onHandover: (handover) => handovers.push(handover as unknown as (typeof handovers)[number]),
    });
    const stored = await fetch(localUrl('/api/remote/settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandbox: { enabled: true, workspaces } }),
    });
    expect(stored.status).toBe(200);
    return { handovers, notices };
  }

  it('answers the enable in full before it stands down, and says the hub is moving', async () => {
    // The whole body has to arrive. Signalling the handover first would tear
    // down the socket carrying it, and the caller would see a connection error
    // it could not tell from a failure to start.
    const { handovers } = await containedServer([process.cwd()]);
    const response = await fetch(localUrl('/api/remote/enable'), { method: 'POST' });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ handingOver: true, state: { status: 'starting' } });
    await vi.waitFor(() => {
      expect(handovers).toHaveLength(1);
    });
  });

  it('hands the container the sessions it will be able to reach', async () => {
    const { handovers } = await containedServer([process.cwd()]);
    await fetch(localUrl('/api/remote/enable'), { method: 'POST' });
    await vi.waitFor(() => {
      expect(handovers).toHaveLength(1);
    });
    expect(handovers[0]?.settings.sandbox.workspaces).toEqual([process.cwd()]);
    expect(handovers[0]?.sessions.map((entry) => entry.id)).toEqual([SESSION]);
  });

  it('names a session the container could not reach rather than dropping it quietly', async () => {
    const { handovers, notices } = await containedServer(['/nowhere-at-all']);
    await fetch(localUrl('/api/remote/enable'), { method: 'POST' });
    await vi.waitFor(() => {
      expect(handovers).toHaveLength(1);
    });
    expect(handovers[0]?.sessions).toEqual([]);
    expect(notices.join('\n')).toContain('outside the mounted workspaces');
    expect(notices.join('\n')).toContain(process.cwd());
  });

  it('starts no tunnel, because the container starts one inside itself', async () => {
    const { handovers } = await containedServer([process.cwd()]);
    await fetch(localUrl('/api/remote/enable'), { method: 'POST' });
    await vi.waitFor(() => {
      expect(handovers).toHaveLength(1);
    });
    expect(tunnelPort).toBeUndefined();
  });
});

describe('what the picker will name for a paired device', () => {
  /**
   * A paired device can ask this route, and an unpinned answer is a map of the
   * machine: every project, every client name, every checkout. So the answer on
   * the tunnel is pinned to the directory the cockpit was started from, while
   * the person at the keyboard, who already has a shell, keeps the whole tree.
   */
  let cookie: string;

  async function browse(url: string, remote = false): Promise<string[]> {
    const response = remote ? await sealedFetch(cookie, new URL(url).pathname + new URL(url).search) : await fetch(url);
    expect(response.status).toBe(200);
    return ((await response.json()) as { directories: string[] }).directories;
  }

  beforeEach(async () => {
    await server.close();
    server = await serveWeb({
      registryDir,
      spawnCommand: path.join(registryDir, 'no-such-server'),
      port: 0,
      assetsDir: '/nonexistent-assets',
      remoteStateDir: stateDir,
      remoteAccess: { launchTunnel: fakeTunnel },
      browseRoot: registryDir,
    });
    await enable();
    cookie = cookieValue(await pair());
  });

  it('names nothing outside the root on the tunnel', async () => {
    expect(await browse(tunnelUrl('/api/directories?q=/'), true)).toEqual([]);
  });

  it('still names what is inside the root', async () => {
    fs.mkdirSync(path.join(registryDir, 'visible'), { recursive: true });
    const query = `/api/directories?q=${encodeURIComponent(`${registryDir}/`)}`;
    expect(await browse(tunnelUrl(query), true)).toContain(path.join(registryDir, 'visible'));
  });

  it('leaves the local picker alone, since a shell is already on this side of it', async () => {
    expect(await browse(localUrl('/api/directories?q=/'))).not.toEqual([]);
  });
});
