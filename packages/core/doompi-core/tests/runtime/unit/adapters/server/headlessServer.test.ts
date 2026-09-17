import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport, type ByteTransportFactory } from '@earendil-works/pi-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type { DoomHubChannel } from '../../../../../src/exports/hubChannel';
import {
  DOOM_SERVER_HOST_SERVICE,
  requireDoomServerHost,
  type DoomServerFacet,
} from '../../../../../src/exports/serverFacet';
import {
  DOOM_COCKPIT_SERVER_ID,
  DoomHubService,
  DoomSessionManagementService,
  DoomSessionService,
} from '../../../../../src/exports/sessionProtocol';
import { createHeadlessHub } from '../../../../../src/server/headlessHub';
import { serveHeadlessServer, type HeadlessServer } from '../../../../../src/server/headlessServer';
import type { HeadlessSessionHost } from '../../../../../src/systems/main/types/headlessSessionHost';

function host() {
  const listeners = new Set<(frame: Record<string, unknown>) => void>();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    exited,
    readEntries: vi.fn(async () => ({ entries: [], leafId: null })),
    readState: vi.fn(async () => ({
      sessionId: 'session',
      model: { provider: 'test', id: 'model' },
      thinkingLevel: 'off',
      isStreaming: false,
    })),
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    prompt: vi.fn(async () => undefined),
    onPresentationFrame(listener: (frame: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listCommands: () => [],
    availableModels: async () => [],
    availableThinkingLevels: async () => [],
    getSessionStats: async () => ({}),
  } as unknown as HeadlessSessionHost['runtime'];
  return {
    host: {
      runtime,
      host: undefined,
      toolSurface: {
        readSurface: () => ({
          revision: 1,
          tools: [{ name: 'read', label: 'Read', description: 'Read a file', parameters: { type: 'object' } as never }],
          skills: [{ name: 'review', description: 'Review code', uri: 'doompi://session/session/skills/review' }],
        }),
        invokeTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] })),
        readSkill: vi.fn(() => '# Review'),
      },
      prepareFacets: () => undefined,
      activateFacets: async () => undefined,
      canDispatch: () => true,
      onPresentationFrame(listener: (frame: Record<string, unknown>) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      respondToExtensionUi: () => false,
      dispose: vi.fn(async () => undefined),
    } satisfies HeadlessSessionHost,
    runtime,
    exit() {
      resolveExit(0);
    },
    emitFrame(frame: Record<string, unknown>) {
      for (const listener of listeners) listener(frame);
    },
  };
}

function websocketTransport(url: string): ByteTransportFactory {
  return async (handlers) => {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    let terminal = false;
    const stop = (error?: Error): void => {
      if (terminal) return;
      terminal = true;
      if (error) handlers.onError(error);
      else handlers.onClose();
    };
    socket.on('message', (data) => handlers.onData(Buffer.from(data as ArrayBuffer)));
    socket.on('close', () => stop());
    socket.on('error', (error) => stop(error));
    return {
      send: (chunk) =>
        new Promise<void>((resolve, reject) => {
          socket.send(chunk, (error) => (error ? reject(error) : resolve()));
        }),
      close() {
        socket.close();
      },
    };
  };
}

const servers: HeadlessServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true })));
});

describe('serveHeadlessServer', () => {
  it('closes active Pi clients before waiting for the HTTP server', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0 });
    servers.push(server);
    const client = await Client.connect({
      serverId: DOOM_COCKPIT_SERVER_ID,
      transportFactory: websocketTransport(`${server.url.replace('http:', 'ws:')}/api/ws`),
    });

    await server.close();
    await client.dispose();
  });

  it('routes host-managed session MCP and public confidential OAuth without the browser token', async () => {
    const first = host();
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'One',
      cwd: '/repo',
      createdAt: 'now',
      host: first.host,
    });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    let publicOrigin = 'https://remote.example.com';
    let publicOriginRevision = 0;
    const root = '/api/workspaces/test-workspace/sessions/one/mcp';
    const server = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      token: 'browser-secret',
      sessionMcpPublicOrigin: () => publicOrigin,
      sessionMcpPublicOriginRevision: () => publicOriginRevision,
    });
    servers.push(server);
    const hostHeaders = { 'x-doompi-token': 'browser-secret' };

    expect((await fetch(`${server.url}${root}/config`)).status).toBe(401);
    const config = await fetch(`${server.url}${root}/config`, { headers: hostHeaders });
    await expect(config.json()).resolves.toMatchObject({
      audience: `${publicOrigin}${root}`,
      authorizationEndpoint: `${publicOrigin}/oauth/authorize`,
      tools: [{ name: 'read' }],
      skills: [{ name: 'review' }],
    });
    expect(
      (
        await fetch(`${server.url}${root}/config`, {
          headers: { authorization: 'Bearer unrelated-application-token', ...hostHeaders },
        })
      ).status,
    ).toBe(200);
    const invalid = await fetch(`${server.url}${root}/clients`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({
        name: 'ChatGPT',
        redirectUri: 'https://chatgpt.com/connector/oauth/callback',
        tools: ['missing'],
        skills: [],
      }),
    });
    expect(invalid.status).toBe(400);
    const created = await fetch(`${server.url}${root}/clients`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({
        name: 'ChatGPT',
        redirectUri: 'https://chatgpt.com/connector/oauth/callback',
        tools: ['read'],
        skills: ['review'],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const createdClient = (await created.json()) as {
      client: { clientId: string; clientSecret: string; redirectUri: string };
    };
    const listed = (await (await fetch(`${server.url}${root}/clients`, { headers: hostHeaders })).json()) as {
      clients: Record<string, unknown>[];
    };
    expect(listed.clients).toHaveLength(1);
    expect(listed.clients[0]).not.toHaveProperty('clientSecret');

    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL('/oauth/authorize', server.url);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', createdClient.client.clientId);
    authorize.searchParams.set('redirect_uri', createdClient.client.redirectUri);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('resource', `${publicOrigin}${root}`);
    authorize.searchParams.set('scope', 'tool:missing');
    authorize.searchParams.set('state', 'kept');
    const invalidAuthorize = new URL(authorize);
    invalidAuthorize.searchParams.set('response_type', 'token');
    const rejectedAuthorization = await fetch(invalidAuthorize, { redirect: 'manual' });
    const rejectedCallback = new URL(rejectedAuthorization.headers.get('location')!);
    expect(rejectedCallback.searchParams.get('error')).toBe('invalid_request');
    expect(rejectedCallback.searchParams.get('state')).toBe('kept');

    const authorized = await fetch(authorize, { redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe('kept');
    const token = await fetch(`${server.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: createdClient.client.clientId,
        client_secret: createdClient.client.clientSecret,
        code: callback.searchParams.get('code')!,
        redirect_uri: createdClient.client.redirectUri,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string };
    const mcp = await fetch(`${server.url}${root}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    await expect(mcp.json()).resolves.toMatchObject({ result: { tools: [{ name: 'read' }] } });
    expect(
      (
        await fetch(`${server.url}${root}`, {
          method: 'POST',
          headers: { 'x-doompi-token': 'browser-secret', 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);

    await hub.closeSession('one');
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'Replacement',
      cwd: '/repo',
      createdAt: 'later',
      host: host().host,
    });
    expect(
      (
        await fetch(`${server.url}${root}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        })
      ).status,
    ).toBe(401);

    publicOrigin = 'https://replacement.example.com';
    const replacedConfig = await fetch(`${server.url}${root}/config`, { headers: hostHeaders });
    expect(replacedConfig.status).toBe(200);
    const replacementListed = (await (
      await fetch(`${server.url}${root}/clients`, { headers: hostHeaders })
    ).json()) as {
      clients: Record<string, unknown>[];
    };
    expect(replacementListed.clients).toHaveLength(0);
    const replacementClient = await fetch(`${server.url}${root}/clients`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({
        name: 'Replacement ChatGPT',
        redirectUri: 'https://chatgpt.com/connector/oauth/replacement',
        tools: ['read'],
        skills: [],
      }),
    });
    expect(replacementClient.status).toBe(201);
    publicOriginRevision += 1;
    const reenabledClients = await fetch(`${server.url}${root}/clients`, { headers: hostHeaders });
    await expect(reenabledClients.json()).resolves.toEqual({ clients: [] });
    await hub.close();
  });

  it('serves mentioned files only from the session working directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-session-file-'));
    temporaryDirectories.push(root);
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'README.md'), '# Local README');
    fs.writeFileSync(path.join(root, 'secret.md'), 'outside');
    fs.symlinkSync(path.join(root, 'secret.md'), path.join(cwd, 'linked.md'));
    fs.writeFileSync(path.join(cwd, 'large.bin'), '');
    fs.truncateSync(path.join(cwd, 'large.bin'), 25 * 1024 * 1024 + 1);

    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({ workspaceId: 'test-workspace', id: 'one', name: 'One', cwd, createdAt: 'now', host: host().host });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    const file = (relativePath: string) =>
      fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/file?path=${encodeURIComponent(relativePath)}`, {
        headers: { 'x-doompi-token': 'secret' },
      });

    expect((await file('README.md')).status).toBe(200);
    expect(await (await file('README.md')).text()).toBe('# Local README');
    expect((await file('../secret.md')).status).toBe(403);
    expect((await file('linked.md')).status).toBe(403);
    expect((await file('missing.md')).status).toBe(404);
    expect((await file('large.bin')).status).toBe(413);
    expect((await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/file?path=README.md`)).status).toBe(
      401,
    );
    await hub.close();
  });

  it('routes restart, history, and resume through the live session lifecycle', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'current',
      name: 'Current',
      cwd: '/repo',
      createdAt: '2025-01-01',
      host: host().host,
    });
    const sessionHistory = vi.fn(async () => [
      {
        id: 'saved',
        firstMessage: 'hello',
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
        messageCount: 1,
      },
    ]);
    const restartSession = vi.fn(async () => undefined);
    const resumeSession = vi.fn(async () => 'saved');
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      sessionHistory,
      restartSession,
      resumeSession,
    });
    servers.push(server);
    expect(await (await fetch(`${server.url}/api/workspaces/test-workspace/sessions/current/history`)).json()).toEqual({
      sessions: await sessionHistory.mock.results[0]?.value,
    });
    expect(
      (await fetch(`${server.url}/api/workspaces/test-workspace/sessions/current/restart`, { method: 'POST' })).status,
    ).toBe(200);
    expect(restartSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'current' }));
    const invalid = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/current/resume`, {
      method: 'POST',
      body: JSON.stringify({ targetSessionId: '../other' }),
    });
    expect(invalid.status).toBe(400);
    expect(resumeSession).not.toHaveBeenCalled();
    const resumed = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/current/resume`, {
      method: 'POST',
      body: JSON.stringify({ targetSessionId: 'saved' }),
    });
    expect(await resumed.json()).toEqual({ sessionId: 'saved' });
    expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'current' }), 'saved');
    await hub.close();
  });

  it('lists dormant records beside live sessions and revives one on request', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'live',
      name: 'Live',
      cwd: '/repo',
      createdAt: '2025-01-01',
      host: host().host,
    });
    const records = [
      {
        sessionId: 'asleep',
        workspaceId: 'test-workspace',
        cwd: '/repo',
        name: 'Asleep',
        createdAt: '2025-01-02',
      },
      // Already live, so it must not be offered a second time as dormant.
      { sessionId: 'live', workspaceId: 'test-workspace', cwd: '/repo', name: 'Live', createdAt: '2025-01-01' },
    ];
    const reviveSession = vi.fn(async () => undefined);
    const removeDormantSession = vi.fn();
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      dormantSessions: () => records,
      removeDormantSession,
      reviveSession,
    });
    servers.push(server);

    const listed = (await (await fetch(`${server.url}/api/workspaces/test-workspace/sessions`)).json()) as {
      sessions: { id: string; dormant?: boolean }[];
    };
    expect(listed.sessions.map((session) => [session.id, session.dormant ?? false])).toEqual([
      ['live', false],
      ['asleep', true],
    ]);

    // The rail reads its snapshot over the protocol socket, not the SSE stream,
    // so that path is what has to carry a dormant card.
    const client = await Client.connect({
      serverId: DOOM_COCKPIT_SERVER_ID,
      transportFactory: websocketTransport(`${server.url.replace('http:', 'ws:')}/api/ws`),
    });
    const binding = createRemoteServiceBinding({
      services: [DoomHubService],
      transport: createClientServiceTransport(client, () => ({ serverId: DOOM_COCKPIT_SERVER_ID })),
    });
    const hubService = binding.use(DoomHubService);
    await binding.ready(BACKGROUND_CONTEXT);
    const snapshot = hubService.state.value?.events[0]?.frame as unknown as {
      sessions: { id: string; dormant?: boolean }[];
    };
    expect(snapshot.sessions.map((session) => [session.id, session.dormant ?? false])).toEqual([
      ['live', false],
      ['asleep', true],
    ]);
    await binding.dispose(BACKGROUND_CONTEXT);
    await client.dispose();
    const revived = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/asleep/revive`, {
      method: 'POST',
    });
    expect(revived.status).toBe(200);
    expect(reviveSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'asleep' }));

    // A live session and a record in another workspace are both unaddressable here.
    expect(
      (await fetch(`${server.url}/api/workspaces/test-workspace/sessions/live/revive`, { method: 'POST' })).status,
    ).toBe(404);
    expect((await fetch(`${server.url}/api/workspaces/other/sessions/asleep/revive`, { method: 'POST' })).status).toBe(
      404,
    );
    expect(reviveSession).toHaveBeenCalledTimes(1);

    const removed = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/asleep`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(removeDormantSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'asleep' }));
    await hub.close();
  });
  it('reads a dormant transcript without reviving it or accepting another workspace', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    const records = [
      { sessionId: 'asleep', workspaceId: 'test-workspace', cwd: '/repo', name: 'Asleep', createdAt: '2025-01-02' },
    ];
    const readDormantTranscript = vi.fn(async () => ({
      entries: [],
      startCursor: null,
      endCursor: null,
      olderCursor: null,
      newerCursor: null,
      generation: 0,
      revision: 0,
      context: [],
      drafts: [],
    }));
    const reviveSession = vi.fn(async () => undefined);
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      dormantSessions: () => records,
      readDormantTranscript,
      reviveSession,
    });
    servers.push(server);

    const page = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/asleep/transcript?limit=10`);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ entries: [], generation: 0 });
    expect(readDormantTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'asleep', workspaceId: 'test-workspace' }),
      { limit: 10 },
      expect.anything(),
    );
    expect(reviveSession).not.toHaveBeenCalled();
    expect((await fetch(`${server.url}/api/workspaces/other/sessions/asleep/transcript`)).status).toBe(404);
    expect(
      (await fetch(`${server.url}/api/workspaces/test-workspace/sessions/asleep/transcript?limit=101`)).status,
    ).toBe(400);
    await hub.close();
  });
  it('serves compositions, assets, remote requests, and directory suggestions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-directories-'));
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, 'Alpha'));
    fs.mkdirSync(path.join(directory, 'alpine'));
    fs.writeFileSync(path.join(directory, 'also-file'), 'not a directory');
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn() } as never });
    const requestApi = vi.spyOn(hub, 'requestApi').mockImplementation(async (_mount, _basePath, request) =>
      Response.json({
        path: new URL(request.url).pathname,
        body: await request.text(),
        header: request.headers.get('x-extra'),
      }),
    );
    const requestAsset = vi.fn(async (request: Request) =>
      new URL(request.url).pathname.endsWith('/found') ? new Response('asset') : undefined,
    );
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({
      headlessHub: hub,
      port: 0,
      token: 'secret',
      compositions: () => ({ workspaces: ['one'] }),
      requestAsset,
    });
    servers.push(server);
    const headers = { authorization: 'Bearer secret' };
    expect(await (await fetch(`${server.url}/api/compositions`, { headers })).json()).toEqual({ workspaces: ['one'] });
    expect(await (await fetch(`${server.url}/api/web-plugins/found`, { headers })).text()).toBe('asset');
    expect((await fetch(`${server.url}/api/web-plugins/missing`, { headers })).status).toBe(404);
    expect(requestAsset).toHaveBeenCalledTimes(2);
    const remote = await fetch(`${server.url}/api/remote/rpc?value=1`, {
      method: 'POST',
      headers: { ...headers, 'x-extra': 'present' },
      body: 'payload',
    });
    expect(await remote.json()).toEqual({ path: '/rpc', body: 'payload', header: 'present' });
    expect(requestApi).toHaveBeenCalledWith({ scope: 'global' }, 'remote', expect.any(Request));
    expect(await (await fetch(`${server.url}/api/directories?q=`, { headers })).json()).toEqual({ directories: [] });
    expect(
      await (
        await fetch(`${server.url}/api/directories?q=${encodeURIComponent(path.join(directory, 'al'))}`, { headers })
      ).json(),
    ).toEqual({ directories: [path.join(directory, 'Alpha'), path.join(directory, 'alpine')] });
    expect(
      await (await fetch(`${server.url}/api/directories?q=${encodeURIComponent(`${directory}/`)}`, { headers })).json(),
    ).toEqual({ directories: [path.join(directory, 'Alpha'), path.join(directory, 'alpine')] });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(directory, 'current'));
    try {
      const sibling = await fetch(`${server.url}/api/directories?q=al`, { headers });
      expect(await sibling.json()).toEqual({
        directories: [path.join(directory, 'Alpha'), path.join(directory, 'alpine')],
      });
    } finally {
      cwd.mockRestore();
    }
    expect(
      await (
        await fetch(`${server.url}/api/directories?q=${encodeURIComponent(path.join(directory, 'absent', 'x'))}`, {
          headers,
        })
      ).json(),
    ).toEqual({ directories: [] });
    await hub.close();
  });

  it('validates workspace requests and reports deletion conflicts', async () => {
    const admitWorkspace = vi.fn(async (root: string) => ({ id: 'one', root }));
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never, admitWorkspace });
    await hub.mountFacets([], { scope: 'workspace', workspaceId: 'one', workspaceRoot: '/one', onNotice: vi.fn() });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0 });
    servers.push(server);
    const post = (body: string) => fetch(`${server.url}/api/workspaces`, { method: 'POST', body });
    expect(await (await fetch(`${server.url}/api/workspaces`)).json()).toEqual({
      workspaces: [
        { id: 'one', root: '/one' },
        { id: 'test-workspace', root: '/repo' },
      ],
    });
    for (const body of ['', 'null', '[]', '{}', '{"root":1}']) {
      const result = await post(body);
      expect(result.status).toBe(400);
    }
    expect(admitWorkspace).not.toHaveBeenCalled();
    const created = await post('{"root":"/new"}');
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ workspace: { id: 'one', root: '/new' } });
    expect((await fetch(`${server.url}/api/workspaces/missing`, { method: 'DELETE' })).status).toBe(404);
    hub.register({ id: 'session', workspaceId: 'one', name: 'One', cwd: '/one', createdAt: 'now', host: host().host });
    expect((await fetch(`${server.url}/api/workspaces/one`, { method: 'DELETE' })).status).toBe(409);
    await hub.closeSession('session');
    expect((await fetch(`${server.url}/api/workspaces/one`, { method: 'DELETE' })).status).toBe(200);
    expect(hub.workspaces()).toEqual([{ id: 'test-workspace', root: '/repo' }]);
    await hub.close();
  });

  it('accepts only bounded browser telemetry events and records scoped API responses', async () => {
    const recordEvent = vi.fn(async () => undefined);
    const runInSpan = vi.fn(async (_name, _attributes, dispatch: () => Promise<Response>) => dispatch());
    const telemetry = { recordEvent, runInSpan } as never;
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn() } as never });
    const requestApi = vi.spyOn(hub, 'requestApi').mockResolvedValue(Response.json({ ok: true }));
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, telemetry });
    servers.push(server);
    const post = (value: unknown) =>
      fetch(`${server.url}/api/telemetry/browser`, { method: 'POST', body: JSON.stringify(value) });
    for (const invalid of [
      { v: 2, events: [] },
      { v: 1, events: null },
      { v: 1, events: Array(11).fill({}) },
    ])
      expect((await post(invalid)).status).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(
      (
        await post({
          v: 1,
          events: [
            null,
            { name: 'bad' },
            { name: 'web.browser.open', duration_ms: 12, count: 2 },
            { name: 'web.browser.close', duration_ms: -1, count: Number.NaN },
          ],
        })
      ).status,
    ).toBe(200);
    expect(recordEvent).toHaveBeenCalledWith('web.browser.open', { duration_ms: 12, count: 2 });
    expect(recordEvent).toHaveBeenCalledWith('web.browser.close', {});
    const plugin = await fetch(`${server.url}/api/plugins/test/path?query=yes`, {
      method: 'POST',
      headers: { 'x-doompi-api-caller-locality': 'forged', 'x-extra': 'allowed' },
      body: 'content',
    });
    expect(await plugin.json()).toEqual({ ok: true });
    expect(runInSpan).toHaveBeenCalledWith(
      'doompi_server.plugin.request',
      expect.objectContaining({ scope: 'global', 'plugin.name': 'test', 'http.operation': 'POST' }),
      expect.any(Function),
    );
    expect(requestApi).toHaveBeenCalledWith({ scope: 'global' }, 'test', expect.any(Request));
    const forwarded = requestApi.mock.calls.at(-1)?.[2];
    expect(forwarded?.headers.get('x-doompi-api-caller-locality')).toBeNull();
    expect(forwarded?.headers.get('x-extra')).toBe('allowed');
    expect(recordEvent).toHaveBeenCalledWith(
      'doompi_server.plugin.response',
      expect.objectContaining({ scope: 'global', status: 200 }),
    );
    await hub.close();
  });

  it('keeps session creation working for a verified browser bundle from before workspace routes', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'created', cwd: '/repo' }));
    const hub = createHeadlessHub({ manager: {} as never, createSession });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    const request = (body: unknown) =>
      fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify(body),
      });

    expect((await request({ cwd: '' })).status).toBe(400);
    const response = await request({ cwd: '/repo', name: 'test' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sessionId: 'created' });
    expect(createSession).toHaveBeenCalledWith({ cwd: '/repo', name: 'test' });
    await hub.close();
  });
  it('creates a root session through the global service without inventing a parent', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'created', cwd: '/repo' }));
    const hub = createHeadlessHub({ manager: {} as never, createSession });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    const request = (body: unknown, authenticated = true) =>
      fetch(`${server.url}/api/workspaces/test-workspace/sessions`, {
        method: 'POST',
        headers: authenticated ? { authorization: 'Bearer secret' } : {},
        body: JSON.stringify(body),
      });
    expect((await request({ cwd: '/repo' }, false)).status).toBe(401);
    expect((await request({ name: 1 })).status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    const response = await request({ cwd: '/repo', name: 'test', parentSessionId: 'forged' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sessionId: 'created' });
    expect(createSession).toHaveBeenCalledWith({ cwd: '/repo', name: 'test' });
    await hub.close();
  });

  it('authenticates HTTP requests and keeps the retired frame route unavailable', async () => {
    const session = host();
    const requestSessionApi = vi.fn(async () => Response.json({ ok: true }));
    const closeSession = vi.fn(async () => undefined);
    const hub = createHeadlessHub({
      manager: { closeSession } as never,
      requestSessionApi,
    });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'One',
      cwd: '/repo',
      createdAt: '2025-01-01T00:00:00.000Z',
      host: session.host,
    });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);

    const unauthorized = await fetch(`${server.url}/api/workspaces/test-workspace/sessions`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${server.url}/api/workspaces/test-workspace/sessions`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: 'one',
          workspaceId: 'test-workspace',
          name: 'One',
          cwd: '/repo',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
          phase: 'idle',
          phaseSince: '2025-01-01T00:00:00.000Z',
          attach: 'attached',
          pendingMessageCount: 0,
          everPrompted: false,
          awaitingInput: false,
        },
      ],
    });
    const directories = await fetch(`${server.url}/api/directories?q=repo`, {
      headers: { authorization: 'Bearer secret' },
    });
    const directoryBody = (await directories.json()) as { directories: string[] };
    expect(directoryBody.directories).toContain('/repo');

    const retired = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/frame`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'prompt', text: 'hello' }),
    });
    expect(retired.status).toBe(404);

    const apiResponse = await fetch(
      `${server.url}/api/workspaces/test-workspace/sessions/one/plugins/test-api/value?x=1`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: 'payload',
      },
    );
    expect(await apiResponse.json()).toEqual({ ok: true });
    expect(requestSessionApi).toHaveBeenCalledWith(
      { sessionId: 'one', workspaceId: 'test-workspace', cwd: '/repo' },
      expect.objectContaining({
        basePath: 'test-api',
        path: '/value?x=1',
        method: 'POST',
        body: new Uint8Array(Buffer.from('payload')),
      }),
    );

    const plugin = await fetch(`${server.url}/api/plugin/test-api/value?session=one&x=2`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(plugin.status).toBe(404);

    const stopped = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer secret' },
    });
    expect(await stopped.json()).toEqual({ ok: true });
    expect(closeSession).toHaveBeenCalledWith('one');
    expect(hub.session('one')).toBeUndefined();
    await hub.close();
  });

  it('hosts discovery, channels, and isolated session services over the Pi byte protocol', async () => {
    const first = host();
    const second = host();
    const third = host();
    const disconnected = vi.fn();
    const receive = vi.fn();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-thread-'));
    temporaryDirectories.push(directory);
    const journal = path.join(directory, 'child.jsonl');
    fs.writeFileSync(
      journal,
      `${JSON.stringify([
        { kind: 'value', id: 'ignored', value: 'metadata' },
        {
          kind: 'entry',
          type: 'message',
          id: 'first',
          message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
        },
      ])}\n`,
    );
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    const channel: DoomHubChannel = {
      frameType: 'test_channel',
      receive: (scope, payload, connection) => receive(scope, payload, connection),
      disconnected,
      start: (hostApi) => {
        channelHost = hostApi;
        return {
          payloadFor: () => ({ ready: true }),
          threadJournal: (_scope, threadId) => (threadId === 'child' ? journal : undefined),
          close: () => undefined,
        };
      },
    };
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    hub.register({
      id: 'one',
      workspaceId: 'workspace-one',
      webComposition: {
        id: 'composition-one',
        scope: 'session',
        revision: 1,
        manifestUrl: '/manifest',
        rawAssetBaseUrl: '/raw',
        verifiedAssetBaseUrl: '/verified',
        entryPath: '/entry.js',
        stylePaths: [],
        channels: [],
      },
      name: 'One',
      cwd: '/one',
      createdAt: '2025-01-01T00:00:00.000Z',
      host: first.host,
    });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'two',
      name: 'Two',
      cwd: '/two',
      createdAt: 'invalid',
      host: second.host,
    });
    hub.registerChannel(channel);
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    const client = await Client.connect({
      serverId: DOOM_COCKPIT_SERVER_ID,
      transportFactory: websocketTransport(`${server.url.replace('http:', 'ws:')}/api/ws?token=secret`),
    });
    const hubBinding = createRemoteServiceBinding({
      services: [DoomHubService],
      transport: createClientServiceTransport(client, () => ({ serverId: DOOM_COCKPIT_SERVER_ID })),
    });
    const hubService = hubBinding.use(DoomHubService);
    await hubBinding.ready(BACKGROUND_CONTEXT);
    expect(hubService.state.value?.events[0]?.frame).toEqual({
      type: 'sessions_snapshot',
      sessions: [
        {
          id: 'one',
          workspaceId: 'workspace-one',
          webComposition: {
            id: 'composition-one',
            scope: 'session',
            revision: 1,
            manifestUrl: '/manifest',
            rawAssetBaseUrl: '/raw',
            verifiedAssetBaseUrl: '/verified',
            entryPath: '/entry.js',
            stylePaths: [],
            channels: [],
          },
          name: 'One',
          cwd: '/one',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
          phase: 'idle',
          phaseSince: '2025-01-01T00:00:00.000Z',
          attach: 'attached',
          pendingMessageCount: 0,
          everPrompted: false,
          awaitingInput: false,
        },
        {
          id: 'two',
          workspaceId: 'test-workspace',
          name: 'Two',
          cwd: '/two',
          createdAt: 'invalid',
          updatedAt: 'invalid',
          phase: 'idle',
          phaseSince: 'invalid',
          attach: 'attached',
          pendingMessageCount: 0,
          everPrompted: false,
          awaitingInput: false,
        },
      ],
    });

    await hubService.send({ type: 'subscribe_thread', sessionId: 'one', threadId: 'child' }, BACKGROUND_CONTEXT);
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) =>
            event.frame.type === 'thread_backlog' &&
            Array.isArray(event.frame.frames) &&
            event.frame.frames.length === 1,
        ),
      ).toBe(true),
    );

    first.emitFrame({ type: 'agent_start' });
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) =>
            event.frame.type === 'session_upsert' &&
            (event.frame.session as { phase?: string }).phase === 'turn' &&
            (event.frame.session as { everPrompted?: boolean }).everPrompted === true,
        ),
      ).toBe(true),
    );
    fs.appendFileSync(
      journal,
      `${JSON.stringify({
        kind: 'entry',
        type: 'message',
        id: 'second',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      })}\n`,
    );
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) => event.frame.type === 'thread_frame' && event.frame.threadId === 'child',
        ),
      ).toBe(true),
    );

    await hubService.send({ type: 'subscribe', sessionId: 'missing' }, BACKGROUND_CONTEXT);
    await hubService.send({ type: 'noop' }, BACKGROUND_CONTEXT);
    await hubService.send({ type: 'subscribe', sessionId: 'one' }, BACKGROUND_CONTEXT);
    await vi.waitFor(() =>
      expect(hubService.state.value?.events.some((event) => event.frame.type === 'test_channel')).toBe(true),
    );
    await hubService.send({ type: 'test_channel', sessionId: 'one', payload: { action: 'run' } }, BACKGROUND_CONTEXT);
    expect(receive).toHaveBeenCalledWith(
      { sessionId: 'one', workspaceId: 'workspace-one', cwd: '/one' },
      { action: 'run' },
      expect.objectContaining({ connectionId: expect.any(String) }),
    );
    const connectionId = (receive.mock.calls[0]![2] as { connectionId: string }).connectionId;
    channelHost?.publishToConnection?.(connectionId, 'one', { targeted: true });
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) =>
            event.frame.type === 'test_channel' &&
            (event.frame.payload as { targeted?: boolean } | undefined)?.targeted === true,
        ),
      ).toBe(true),
    );
    const targetedCount = hubService.state.value?.events.length;
    channelHost?.publishToConnection?.('another-client', 'one', { hidden: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hubService.state.value?.events).toHaveLength(targetedCount ?? 0);

    hub.register({
      workspaceId: 'test-workspace',
      id: 'three',
      name: 'Three',
      cwd: '/three',
      createdAt: 'now',
      host: third.host,
    });
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) => event.frame.type === 'session_upsert' && (event.frame.session as { id?: string }).id === 'three',
        ),
      ).toBe(true),
    );
    await hub.closeSession('three');
    await vi.waitFor(() =>
      expect(
        hubService.state.value?.events.some(
          (event) => event.frame.type === 'session_removed' && event.frame.sessionId === 'three',
        ),
      ).toBe(true),
    );
    await hubService.send({ type: 'unsubscribe', sessionId: 'one' }, BACKGROUND_CONTEXT);
    await hubService.send({ type: 'subscribe', sessionId: 'one' }, BACKGROUND_CONTEXT);

    await expect(
      client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: ['missing'] },
      ),
    ).rejects.toThrow();
    await client.request(
      { serverId: DOOM_COCKPIT_SERVER_ID },
      { serviceId: DoomSessionManagementService.id, member: 'attach', args: ['one'] },
    );
    const sessionBinding = createRemoteServiceBinding({
      services: [DoomSessionService],
      transport: createClientServiceTransport(client, () => client.attachment),
    });
    const sessionService = sessionBinding.use(DoomSessionService);
    await sessionBinding.ready(BACKGROUND_CONTEXT);
    await sessionService.prompt({ text: 'hello', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(first.runtime.submitPrompt).toHaveBeenCalledWith('hello', undefined);
    expect(second.runtime.submitPrompt).not.toHaveBeenCalled();

    await sessionBinding.dispose(BACKGROUND_CONTEXT);
    await hubBinding.dispose(BACKGROUND_CONTEXT);
    await client.dispose();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    await hub.close();
  });

  it('reattaches a Pi client to a replacement runtime with the same session id', async () => {
    const first = host();
    const second = host();
    const hub = createHeadlessHub({
      manager: {
        closeSession: vi.fn(async (sessionId: string) => {
          if (sessionId === 'one') first.exit();
        }),
      } as never,
    });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'First',
      cwd: '/repo',
      createdAt: 'now',
      host: first.host,
    });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0 });
    servers.push(server);
    const client = await Client.connect({
      serverId: DOOM_COCKPIT_SERVER_ID,
      transportFactory: websocketTransport(`${server.url.replace('http:', 'ws:')}/api/ws`),
    });
    const attach = () =>
      client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: ['one'] },
      );
    await attach();
    const firstBinding = createRemoteServiceBinding({
      services: [DoomSessionService],
      transport: createClientServiceTransport(client, () => client.attachment),
    });
    await firstBinding.ready(BACKGROUND_CONTEXT);
    await firstBinding.use(DoomSessionService).prompt({ text: 'before', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(first.runtime.submitPrompt).toHaveBeenCalledWith('before', undefined);

    await hub.closeSession('one');
    await vi.waitFor(() => expect(client.attachment).toBeUndefined());
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'Second',
      cwd: '/repo',
      createdAt: 'later',
      host: second.host,
    });
    await attach();
    const secondBinding = createRemoteServiceBinding({
      services: [DoomSessionService],
      transport: createClientServiceTransport(client, () => client.attachment),
    });
    await secondBinding.ready(BACKGROUND_CONTEXT);
    await secondBinding.use(DoomSessionService).prompt({ text: 'after', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(second.runtime.submitPrompt).toHaveBeenCalledWith('after', undefined);
    expect(first.runtime.submitPrompt).not.toHaveBeenCalledWith('after', undefined);

    await secondBinding.dispose(BACKGROUND_CONTEXT);
    await firstBinding.dispose(BACKGROUND_CONTEXT);
    await client.dispose();
    await hub.close();
  });

  it('serves health, events, package APIs, and channel HTTP routes from the same hub', async () => {
    const session = host();
    const receive = vi.fn();
    let channelHost: Parameters<DoomHubChannel['start']>[0] | undefined;
    const requestSessionApi = vi.fn(async (_scope, request) =>
      request.method === 'HEAD' ? new Response(null, { status: 204 }) : Response.json({ path: request.path }),
    );
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      requestSessionApi,
    });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'One',
      cwd: '/repo',
      createdAt: 'now',
      host: session.host,
    });
    hub.registerChannel({
      frameType: 'updates',
      receive: (scope, payload, connection) => receive(scope, payload, connection),
      start: (hostApi) => {
        channelHost = hostApi;
        return { payloadFor: () => ({ ready: true }), close: () => undefined };
      },
    });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);
    expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
      ok: true,
      role: 'hub',
      sessions: 1,
    });
    expect((await fetch(`${server.url}/missing`, { headers: { 'x-doompi-token': 'secret' } })).status).toBe(404);
    expect(
      (
        await fetch(`${server.url}/api/workspaces/test-workspace/sessions/missing`, {
          headers: { 'x-doompi-token': 'secret' },
        })
      ).status,
    ).toBe(404);
    expect(
      await (
        await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one`, {
          headers: { 'x-doompi-token': 'secret' },
        })
      ).json(),
    ).toMatchObject({
      id: 'one',
    });
    expect(
      await (
        await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/channels`, {
          headers: { 'x-doompi-token': 'secret' },
        })
      ).json(),
    ).toEqual({ channels: [{ type: 'updates', sessionId: 'one', payload: { ready: true } }] });
    expect(
      (
        await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/channel/updates`, {
          method: 'POST',
          headers: { 'x-doompi-token': 'secret', 'x-doompi-connection': 'http-client' },
          body: JSON.stringify({ action: 'refresh' }),
        })
      ).status,
    ).toBe(202);
    expect(receive).toHaveBeenCalledWith(
      { sessionId: 'one', workspaceId: 'test-workspace', cwd: '/repo' },
      { action: 'refresh' },
      { connectionId: 'http-client' },
    );
    expect(
      (
        await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/plugins/INVALID/value`, {
          headers: { 'x-doompi-token': 'secret' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/plugins/test/value`, {
          method: 'HEAD',
          headers: { 'x-doompi-token': 'secret' },
        })
      ).status,
    ).toBe(204);

    const abort = new AbortController();
    const events = await fetch(`${server.url}/api/events?token=secret`, { signal: abort.signal });
    const reader = events.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toContain('sessions_snapshot');
    channelHost?.publish('one', { updated: true });
    const live = await reader?.read();
    expect(Buffer.from(live?.value ?? []).toString()).toContain('channel_frame');
    abort.abort();
    await hub.close();
  });

  it('returns JSON failures for malformed channel payloads and backend API errors', async () => {
    const session = host();
    const requestSessionApi = vi.fn(async () => {
      throw new Error('package API unavailable');
    });
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      requestSessionApi,
    });
    hub.register({
      workspaceId: 'test-workspace',
      id: 'one',
      name: 'One',
      cwd: '/repo',
      createdAt: 'now',
      host: session.host,
    });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);

    const malformed = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/channel/updates`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: 'not-json',
    });
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({ error: expect.any(String) });

    const backendFailure = await fetch(`${server.url}/api/workspaces/test-workspace/sessions/one/plugins/test/value`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(backendFailure.status).toBe(500);
    expect(await backendFailure.json()).toEqual({ error: 'package API unavailable' });

    await server.close();
    await server.close();
    await hub.close();
  });

  it('rejects unauthorized Pi connections and retires the JSON socket route', async () => {
    const hub = createHeadlessHub({ manager: { closeSession: vi.fn(async () => undefined) } as never });
    await hub.mountFacets([], {
      scope: 'workspace',
      workspaceId: 'test-workspace',
      workspaceRoot: '/repo',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0, token: 'secret' });
    servers.push(server);

    const connect = (path: string) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}${path}`);
        socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        socket.once('error', () => resolve(0));
      });
    await expect(connect('/api/ws')).resolves.toBe(401);
    await expect(connect('/api/session?token=secret')).resolves.toBe(404);
    await hub.close();
  });
});

describe('canonical scoped routes', () => {
  it('rejects retired routes and cross-workspace REST and WebSocket access', async () => {
    const requestSessionApi = vi.fn(async () => Response.json({ ok: true }));
    const hub = createHeadlessHub({
      manager: { closeSession: vi.fn(async () => undefined) } as never,
      requestSessionApi,
    });
    for (const id of ['alpha', 'beta']) {
      await hub.mountFacets([], { scope: 'workspace', workspaceId: id, workspaceRoot: `/${id}`, onNotice: vi.fn() });
      hub.register({
        id: `${id}-session`,
        workspaceId: id,
        name: id,
        cwd: `/${id}`,
        createdAt: 'now',
        host: host().host,
      });
    }
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0 });
    servers.push(server);
    const root = '/api/workspaces/alpha/sessions/alpha-session';
    expect((await fetch(`${server.url}${root}`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/api/workspaces/alpha/sessions`)).json()).toEqual({
      sessions: [expect.objectContaining({ id: 'alpha-session', workspaceId: 'alpha' })],
    });
    expect((await fetch(`${server.url}${root}/plugins/test/value`)).status).toBe(200);
    for (const route of [
      '/api/sessions',
      '/api/sessions/alpha-session',
      '/api/global/plugin/test',
      '/api/workspaces/beta/sessions/alpha-session',
      '/api/workspaces/beta/sessions/alpha-session/plugins/test/value',
    ]) {
      expect((await fetch(`${server.url}${route}`)).status).toBe(404);
    }
    expect(requestSessionApi).toHaveBeenCalledTimes(1);
    const rejected = (route: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}${route}`);
        socket.on('unexpected-response', (_request, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode!);
        });
        socket.on('open', () => {
          socket.close();
          reject(new Error('Unexpected upgrade'));
        });
        socket.on('error', () => undefined);
      });
    expect(await rejected('/api/pi')).toBe(404);
    expect(await rejected('/api/workspaces/beta/sessions/alpha-session/ws')).toBe(404);
    for (const route of ['/api/workspaces/alpha/ws', `${root}/ws`]) {
      const client = await Client.connect({
        serverId: DOOM_COCKPIT_SERVER_ID,
        transportFactory: websocketTransport(`${server.url.replace('http:', 'ws:')}${route}`),
      });
      const binding = createRemoteServiceBinding({
        services: [DoomHubService, DoomSessionManagementService],
        transport: createClientServiceTransport(client, () => ({ serverId: DOOM_COCKPIT_SERVER_ID })),
      });
      const scopedHub = binding.use(DoomHubService);
      const management = binding.use(DoomSessionManagementService);
      await binding.ready(BACKGROUND_CONTEXT);
      expect(scopedHub.state.value?.events[0]?.frame).toEqual({
        type: 'sessions_snapshot',
        sessions: [expect.objectContaining({ id: 'alpha-session' })],
      });
      await expect(management.attach('beta-session', BACKGROUND_CONTEXT)).rejects.toThrow();
      await management.attach('alpha-session', BACKGROUND_CONTEXT);
      await binding.dispose(BACKGROUND_CONTEXT);
      await client.dispose();
    }
    await hub.close();
  });

  it('mounts settings directly in the selected global or workspace composition', async () => {
    const hub = createHeadlessHub({ manager: {} as never });
    const facet: DoomServerFacet = {
      inject: [DOOM_SERVER_HOST_SERVICE],
      apply(context) {
        const registration = requireDoomServerHost(context).registerApi({
          basePath: 'settings',
          start: () => ({
            fetch: (request: Request) => Response.json({ path: new URL(request.url).pathname }),
            close() {},
          }),
        });
        return () => registration.dispose();
      },
    };
    await hub.mountFacets([facet]);
    await hub.mountFacets([facet], {
      scope: 'workspace',
      workspaceId: 'alpha',
      workspaceRoot: '/alpha',
      onNotice: vi.fn(),
    });
    const server = await serveHeadlessServer({ headlessHub: hub, port: 0 });
    servers.push(server);
    for (const route of ['/api/settings', '/api/workspaces/alpha/settings']) {
      expect(await (await fetch(`${server.url}${route}`)).json()).toEqual({ path: '/' });
    }
    expect((await fetch(`${server.url}/api/plugins/settings`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/workspaces/missing/settings`)).status).toBe(404);
    await hub.close();
  });
});
