import fs from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientHandshake } from '@agimon-ai/doompi-web-security/node';
import WebSocket, { WebSocketServer } from 'ws';
import { createRemoteRuntime, type RemoteRuntime } from '../../../../../src/server/remoteRuntime';

const PUBLIC_ORIGIN = 'https://remote.example.com';
const trust = { publicKey: Buffer.alloc(32, 7).toString('base64url'), revision: 1 };
const homes: string[] = [];
const runtimes: RemoteRuntime[] = [];
const protocols: WebSocketServer[] = [];
const frontends: Server[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(protocols.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(frontends.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function runtime(): RemoteRuntime {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-remote-test-'));
  homes.push(homeDirectory);
  const protocol = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  protocols.push(protocol);
  protocol.on('connection', (socket) => socket.on('message', (message) => socket.send(message)));
  const value = createRemoteRuntime({
    homeDirectory,
    registrationToken: 'isolated-registration-token',
    bundleTrust: () => trust,
    onNotice: () => undefined,
    forward: async () => Response.json({ ok: true }),
    connectProtocol: () => {
      const address = protocol.address();
      if (!address || typeof address === 'string') throw new Error('The test protocol is not ready.');
      return new WebSocket(`ws://127.0.0.1:${String(address.port)}`);
    },
    launchTunnel: async ({ acceptOrigin }) => {
      acceptOrigin?.(PUBLIC_ORIGIN);
      return { ok: true, publicOrigin: PUBLIC_ORIGIN, stop: async () => undefined };
    },
  });
  runtimes.push(value);
  return value;
}

function local(
  runtime: RemoteRuntime,
  path: string,
  method = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return runtime.fetchLocal(
    new Request(`http://doompi.local${path}`, {
      method,
      headers: { ...extraHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function tunnel(port: number, route: string, method = 'GET', body?: unknown, cookie?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          host: 'remote.example.com',
          ...(cookie === undefined ? {} : { cookie }),
          ...(method === 'GET' ? {} : { origin: PUBLIC_ORIGIN, 'content-type': 'application/json' }),
        },
      },
      async (response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('global remote control', () => {
  it('enables a separate guarded listener and completes host-approved pairing', async () => {
    const control = runtime();
    const first = await local(control, '/api/remote');
    expect(first.status).toBe(200);
    expect(((await first.json()) as { state: { status: string } }).state.status).toBe('off');
    const configured = await local(control, '/api/remote/settings', 'PUT', {
      tunnel: { kind: 'named', hostname: 'remote.example.com' },
    });
    expect(configured.status).toBe(200);
    expect((await local(control, '/api/remote/enable', 'POST')).status).toBe(200);
    const port = control.remote.tunnelPort();
    expect(port).toBeTypeOf('number');
    const publicPort = port!;

    const page = await tunnel(publicPort, '/pair');
    const pageHtml = await page.text();
    expect(page.status, pageHtml).toBe(200);
    expect(pageHtml).toContain('doompi-pairing-page');
    expect((await tunnel(publicPort, '/api/remote')).status).toBe(401);
    const minted = await local(control, '/api/remote/codes', 'POST');
    expect(minted.status).toBe(201);
    const code = ((await minted.json()) as { code: string }).code;
    const claimed = await tunnel(publicPort, '/api/remote/pair', 'POST', { code });
    expect(claimed.status).toBe(202);
    const requestId = ((await claimed.json()) as { requestId: string }).requestId;
    const state = ((await (await local(control, '/api/remote')).json()) as { state: { pending: unknown[] } }).state;
    expect(state.pending).toHaveLength(1);
    expect((await local(control, `/api/remote/pairing/${requestId}/approve`, 'POST')).status).toBe(200);
    const redeemed = await tunnel(publicPort, `/api/remote/pair/status?request=${requestId}`);
    const approval = (await redeemed.json()) as { status: string; hostPublicKey: string };
    expect(approval.status).toBe('approved');
    expect(redeemed.headers.get('set-cookie')).toContain('__Host-doompi_device=');
    expect(redeemed.headers.get('set-cookie')).toContain('Secure');
    const cookie = redeemed.headers.get('set-cookie')!.split(';')[0];
    const frontend = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>isolated cockpit</title>');
    });
    frontends.push(frontend);
    await new Promise<void>((resolve) => frontend.listen(0, '127.0.0.1', resolve));
    const address = frontend.address();
    if (!address || typeof address === 'string') throw new Error('The test frontend is not ready.');
    expect(
      (
        await local(control, '/api/remote/frontend', 'POST', {
          origin: `http://127.0.0.1:${String(address.port)}`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await local(
          control,
          '/api/remote/frontend',
          'POST',
          {
            origin: `http://127.0.0.1:${String(address.port)}`,
          },
          { 'x-doompi-web-registration': 'isolated-registration-token' },
        )
      ).status,
    ).toBe(200);
    const shell = await tunnel(publicPort, '/', 'GET', undefined, cookie);
    expect(await shell.text()).toContain('isolated cockpit');
    expect((await tunnel(publicPort, '/api/remote', 'GET', undefined, cookie)).status).toBe(401);
    const client = createClientHandshake();
    const channel = client.accept(approval.hostPublicKey)!;
    expect(
      (
        await tunnel(
          publicPort,
          '/api/remote/channel',
          'POST',
          { scope: 'http', clientPublicKey: client.publicKey },
          cookie,
        )
      ).status,
    ).toBe(200);
    const query = channel.seal(
      Buffer.from(JSON.stringify({ v: 1, method: 'GET', target: '/api/remote', headers: [] })),
    );
    expect(query.ok).toBe(true);
    if (!query.ok) throw new Error('Could not seal the test request.');
    const gateway = await tunnel(publicPort, '/api/remote/request', 'POST', query.envelope, cookie);
    expect(gateway.status).toBe(200);
    const opened = channel.open(await gateway.json());
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Could not open the test response.');
    const inner = JSON.parse(Buffer.from(opened.plaintext).toString('utf8')) as { body: string; status: number };
    expect(inner.status).toBe(200);
    expect(
      (JSON.parse(Buffer.from(inner.body, 'base64').toString('utf8')) as { state: { status: string } }).state.status,
    ).toBe('on');
    const passkeyStart = await tunnel(publicPort, '/api/remote/passkeys/register/begin', 'POST', {}, cookie);
    expect(passkeyStart.status, await passkeyStart.clone().text()).toBe(200);
    const passkeyCeremony = (await passkeyStart.json()) as { ceremonyId: string; options: unknown };
    expect(passkeyCeremony.ceremonyId).toBeTypeOf('string');
    expect(passkeyCeremony.options).toBeTypeOf('object');
    const invalidPasskey = await tunnel(
      publicPort,
      '/api/remote/passkeys/register/finish',
      'POST',
      { ceremonyId: passkeyCeremony.ceremonyId, response: {} },
      cookie,
    );
    expect(invalidPasskey.status).toBe(400);
    const protocolClient = createClientHandshake();
    const protocolChannel = protocolClient.accept(approval.hostPublicKey)!;
    expect(
      (
        await tunnel(
          publicPort,
          '/api/remote/channel',
          'POST',
          { scope: 'protocol', clientPublicKey: protocolClient.publicKey },
          cookie,
        )
      ).status,
    ).toBe(200);
    const socket = new WebSocket(`ws://127.0.0.1:${String(publicPort)}/api/pi`, {
      headers: { host: 'remote.example.com', origin: PUBLIC_ORIGIN, cookie },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const echoed = new Promise<string>((resolve, reject) => {
      socket.once('message', (message) => {
        try {
          const opened = protocolChannel.open(JSON.parse(Buffer.from(message as Buffer).toString('utf8')));
          if (!opened.ok) throw new Error(`The echoed protocol frame was refused: ${opened.failure}.`);
          resolve(Buffer.from(opened.plaintext).toString('utf8'));
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
    });
    const outbound = protocolChannel.seal(Buffer.from('protocol smoke'));
    if (!outbound.ok) throw new Error('Could not seal the protocol frame.');
    socket.send(Buffer.from(JSON.stringify(outbound.envelope)));
    expect(await echoed).toBe('protocol smoke');
    socket.close();
    expect((await tunnel(publicPort, `/api/remote/pair/status?request=${requestId}`)).status).toBe(200);
    expect((await local(control, '/api/remote/disable', 'POST')).status).toBe(200);
    expect(control.remote.tunnelPort()).toBeUndefined();
  });
});
