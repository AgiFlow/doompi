import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createClientHandshake } from '@agimon-ai/doompi-web-security/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { createHeadlessHub, type HeadlessHub } from '../../../../../src/server/headlessHub';
import { serveHeadlessServer, type HeadlessServer } from '../../../../../src/server/headlessServer';
import { createRemoteRuntime, type RemoteRuntime } from '../../../../../src/server/remoteRuntime';

const PUBLIC_ORIGIN = 'https://remote.example.com';
const trust = { publicKey: Buffer.alloc(32, 7).toString('base64url'), revision: 1 };
const homes: string[] = [];
const runtimes: RemoteRuntime[] = [];
const protocols: WebSocketServer[] = [];
const frontends: Server[] = [];
const headlessServers: HeadlessServer[] = [];
const hubs: HeadlessHub[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(headlessServers.splice(0).map((server) => server.close()));
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  await Promise.all(protocols.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(frontends.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function runtime(
  forward: (request: Request) => Promise<Response> = async () => Response.json({ ok: true }),
): RemoteRuntime {
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
    forward,
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

function tunnel(
  port: number,
  route: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
  includeOrigin = true,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const form = body instanceof URLSearchParams;
    const encodedBody = body === undefined ? undefined : form ? body.toString() : JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          host: 'remote.example.com',
          ...(cookie === undefined ? {} : { cookie }),
          ...(method === 'GET'
            ? {}
            : {
                ...(includeOrigin ? { origin: PUBLIC_ORIGIN } : {}),
                'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
              }),
          ...extraHeaders,
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
    request.end(encodedBody);
  });
}

describe('global remote control', () => {
  it('forwards only the exact public MCP and OAuth allowlist without pairing', async () => {
    const forward = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const control = runtime(forward);
    await local(control, '/api/remote/settings', 'PUT', {
      tunnel: { kind: 'named', hostname: 'remote.example.com' },
    });
    expect((await local(control, '/api/remote/enable', 'POST')).status).toBe(200);
    const port = control.remote.tunnelPort()!;
    const discovery = await tunnel(port, '/.well-known/oauth-authorization-server');
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ path: '/.well-known/oauth-authorization-server' });
    const mcp = await tunnel(port, '/api/workspaces/work/sessions/session/mcp', 'POST', {}, undefined, false);
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toEqual({ path: '/api/workspaces/work/sessions/session/mcp' });
    const peerInbox = await tunnel(port, '/api/plugins/session-peer/inbox', 'POST', {}, undefined, false);
    expect(peerInbox.status).toBe(200);
    expect(await peerInbox.json()).toEqual({ path: '/api/plugins/session-peer/inbox' });
    const token = await tunnel(port, '/oauth/token', 'POST', {}, undefined, false);
    expect(token.status).toBe(200);
    expect(await token.json()).toEqual({ path: '/oauth/token' });
    expect((await tunnel(port, '/api/plugins/session-peer/other', 'POST', {}, undefined, false)).status).toBe(403);
    expect((await tunnel(port, '/api/workspaces/work/sessions/session/mcp/clients')).status).toBe(401);
    expect((await tunnel(port, '/oauth/register', 'POST', {})).status).toBe(401);
    expect(forward).toHaveBeenCalledTimes(4);
  });

  it('completes session MCP OAuth and lists tools through the public tunnel', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hubs.push(hub);
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'One',
      cwd: '/repo',
      createdAt: 'now',
      host: {
        runtime: { exited: new Promise<number>(() => undefined) } as never,
        host: undefined,
        toolSurface: {
          readSurface: () => ({
            revision: 1,
            tools: [
              { name: 'read', label: 'Read', description: 'Read a file', parameters: { type: 'object' } as never },
            ],
            skills: [],
          }),
          invokeTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] })),
          readSkill: vi.fn(),
        },
        mcpSurface: {
          readSurface: () => ({
            revision: 1,
            tools: [
              { name: 'read', label: 'Read', description: 'Read a file', parameters: { type: 'object' } as never },
            ],
            skills: [],
          }),
          invokeTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] })),
          readSkill: vi.fn(),
        },
        prepareFacets: () => undefined,
        activateFacets: async () => undefined,
        canDispatch: () => true,
        onPresentationFrame: () => () => undefined,
        respondToExtensionUi: () => false,
        dispose: vi.fn(async () => undefined),
      },
    });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    let server!: HeadlessServer;
    const control = runtime(async (request) => {
      const source = new URL(request.url);
      return fetch(new URL(`${source.pathname}${source.search}`, server.url), {
        method: request.method,
        headers: request.headers,
        redirect: 'manual',
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
      });
    });
    server = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      token: 'browser-secret',
      sessionMcpPublicOrigin: () => control.remote.publicOrigin(),
      sessionMcpPublicOriginRevision: () => control.remote.publicOriginRevision(),
    });
    headlessServers.push(server);
    await local(control, '/api/remote/settings', 'PUT', {
      tunnel: { kind: 'named', hostname: 'remote.example.com' },
    });
    expect((await local(control, '/api/remote/enable', 'POST')).status).toBe(200);

    const root = '/api/workspaces/test-workspace/sessions/one/mcp';
    const created = await fetch(`${server.url}${root}/clients`, {
      method: 'POST',
      headers: { 'x-doompi-token': 'browser-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'session',
        redirectUri: 'https://chatgpt.com/connector/oauth/callback',
      }),
    });
    expect(created.status).toBe(201);
    const client = (await created.json()) as {
      client: { clientId: string; clientSecret: string; redirectUri: string };
    };
    const verifier = 'v'.repeat(43);
    const authorize = new URL('/oauth/authorize', PUBLIC_ORIGIN);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', client.client.clientId);
    authorize.searchParams.set('redirect_uri', client.client.redirectUri);
    authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('resource', `${PUBLIC_ORIGIN}${root}`);
    authorize.searchParams.set('state', 'kept');
    const authorized = await tunnel(control.remote.tunnelPort()!, `${authorize.pathname}${authorize.search}`);
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(client.client.redirectUri);
    expect(callback.searchParams.get('state')).toBe('kept');
    expect(callback.searchParams.get('code')).toBeTruthy();
    expect(callback.searchParams.get('error')).toBeNull();

    const token = await tunnel(
      control.remote.tunnelPort()!,
      '/oauth/token',
      'POST',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client.clientId,
        client_secret: client.client.clientSecret,
        code: callback.searchParams.get('code')!,
        redirect_uri: client.client.redirectUri,
        code_verifier: verifier,
      }),
      undefined,
      false,
    );
    expect(token.status, await token.clone().text()).toBe(200);
    const tokens = (await token.json()) as { access_token: string };
    const mcp = await tunnel(
      control.remote.tunnelPort()!,
      root,
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      undefined,
      false,
      {
        authorization: `Bearer ${tokens.access_token}`,
        accept: 'application/json, text/event-stream',
      },
    );
    expect(mcp.status, await mcp.clone().text()).toBe(200);
    await expect(mcp.json()).resolves.toMatchObject({ result: { tools: [{ name: 'read' }] } });
  });

  it('aborts a forwarded public MCP request when the tunnel client disconnects', async () => {
    let markStarted: (() => void) | undefined;
    let markAborted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const control = runtime(async (request) => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            markAborted?.();
            resolve();
          },
          { once: true },
        );
      });
      return new Response(null, { status: 499 });
    });
    await local(control, '/api/remote/settings', 'PUT', {
      tunnel: { kind: 'named', hostname: 'remote.example.com' },
    });
    expect((await local(control, '/api/remote/enable', 'POST')).status).toBe(200);
    const request = httpRequest({
      host: '127.0.0.1',
      port: control.remote.tunnelPort()!,
      path: '/api/workspaces/work/sessions/session/mcp',
      method: 'POST',
      headers: { host: 'remote.example.com', 'content-type': 'application/json' },
    });
    request.once('error', () => undefined);
    request.end('{}');
    await started;
    request.destroy();
    await aborted;
  });
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
    const manifest = await tunnel(publicPort, '/bundle-manifest.json', 'GET', undefined, cookie);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toEqual({ ok: true });
    const bundleAsset = await tunnel(publicPort, '/bundle-assets/1/index.html', 'GET', undefined, cookie);
    expect(bundleAsset.status).toBe(200);
    expect(await bundleAsset.json()).toEqual({ ok: true });
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
    const management = channel.seal(
      Buffer.from(
        JSON.stringify({
          v: 1,
          method: 'GET',
          target: '/api/workspaces/test-workspace/sessions/one/mcp/clients',
          headers: [],
        }),
      ),
    );
    if (!management.ok) throw new Error('Could not seal the MCP management request.');
    const managementGateway = await tunnel(publicPort, '/api/remote/request', 'POST', management.envelope, cookie);
    const openedManagement = channel.open(await managementGateway.json());
    expect(openedManagement.ok).toBe(true);
    if (!openedManagement.ok) throw new Error('Could not open the MCP management response.');
    expect((JSON.parse(Buffer.from(openedManagement.plaintext).toString('utf8')) as { status: number }).status).toBe(
      403,
    );
    const create = channel.seal(
      Buffer.from(
        JSON.stringify({
          v: 1,
          method: 'POST',
          target: '/api/workspaces/test-workspace/sessions',
          headers: [['content-type', 'application/json']],
          body: Buffer.from(JSON.stringify({ cwd: '/workspace' })).toString('base64'),
        }),
      ),
    );
    if (!create.ok) throw new Error('Could not seal the session creation request.');
    const challenged = await tunnel(publicPort, '/api/remote/request', 'POST', create.envelope, cookie);
    expect(challenged.status).toBe(200);
    const openedChallenge = channel.open(await challenged.json());
    expect(openedChallenge.ok).toBe(true);
    if (!openedChallenge.ok) throw new Error('Could not open the step-up challenge.');
    const challenge = JSON.parse(Buffer.from(openedChallenge.plaintext).toString('utf8')) as {
      status: number;
      body: string;
    };
    expect(challenge.status).toBe(401);
    expect(JSON.parse(Buffer.from(challenge.body, 'base64').toString('utf8'))).toMatchObject({
      action: 'session.create',
    });
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
    const socket = new WebSocket(`ws://127.0.0.1:${String(publicPort)}/api/ws`, {
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
