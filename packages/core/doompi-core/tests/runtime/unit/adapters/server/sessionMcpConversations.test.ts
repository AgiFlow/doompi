import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DoomHubSessionCreateRequest } from '../../../../../src/schemas/hubChannel';
import type { HeadlessHub, HeadlessHubEvent, HeadlessHubSession } from '../../../../../src/server/headlessHub';
import { createSessionMcpRoutes, type SessionMcpRoutes } from '../../../../../src/server/sessionMcpRoutes';
import { createSessionMcpAuthorizationService } from '../../../../../src/services/sessionMcpAuthorization';
import { createSessionMcpConversationStore } from '../../../../../src/services/sessionMcpConversations';
import { createSessionMcpRegistrationStore } from '../../../../../src/services/sessionMcpRegistrationStore';
import type { SessionToolInvocation, SessionToolSurface } from '../../../../../src/types/server/sessionToolSurface';

const roots: string[] = [];
const routePath = '/api/workspaces/workspace/sessions/parent/mcp';
const audience = `https://host.example${routePath}`;
const verifier = 'v'.repeat(43);
const handlers: SessionMcpRoutes[] = [];
afterEach(() => {
  for (const routes of handlers.splice(0)) routes.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(routing: 'session' | 'conversation' = 'conversation') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-routing-')));
  roots.push(root);
  const parentCwd = path.join(root, 'parent');
  fs.mkdirSync(parentCwd);
  const store = createSessionMcpConversationStore(path.join(root, 'state'));
  const authorization = createSessionMcpAuthorizationService();
  const listeners = new Set<(event: HeadlessHubEvent) => void>();
  const sessions = new Map<string, HeadlessHubSession>();
  const persisted = new Map<string, string>();
  const surfaces = new Map<string, SessionToolSurface>();
  const addSession = (id: string, cwd: string, parentSessionId?: string): void => {
    const surface: SessionToolSurface = {
      readSurface: () => ({
        revision: 1,
        tools: ['write', 'load_context', 'load_skill'].map((name) => ({
          name,
          label: name,
          description: name,
          parameters: Type.Object({ path: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
        })),
        skills: [{ name: 'guide', description: 'Target guide', uri: `doompi://session/${id}/guide` }],
      }),
      invokeTool: vi.fn(async (invocation: SessionToolInvocation) => {
        await invocation.authorize?.();
        if (invocation.name === 'write')
          fs.writeFileSync(path.join(cwd, String(invocation.arguments.path)), String(invocation.arguments.text));
        const text = invocation.name === 'load_skill' ? await invocation.mcpSkills!.read('guide') : id;
        return { content: [{ type: 'text' as const, text }], structuredContent: { sessionId: id, cwd } };
      }),
      readSkill: () => `guide for ${id}`,
    };
    surfaces.set(id, surface);
    const session = {
      id,
      cwd,
      name: id,
      workspaceId: id === 'parent' ? 'workspace' : `workspace-${id}`,
      createdAt: new Date().toISOString(),
      parentSessionId,
      host: { mcpSurface: surface },
    } as unknown as HeadlessHubSession;
    sessions.set(id, session);
    persisted.set(id, cwd);
    for (const listener of listeners) listener({ kind: 'upsert', session });
  };
  addSession('parent', parentCwd);
  let routes: SessionMcpRoutes;
  const create = vi.fn(async (request: DoomHubSessionCreateRequest) => {
    const reserved = routes.reservations.read(request.reservationId!, request.parentSessionId!);
    await new Promise<void>((resolve) => setImmediate(resolve));
    addSession(reserved.sessionId, request.cwd, request.parentSessionId);
    return { sessionId: reserved.sessionId, cwd: request.cwd, workspaceId: `workspace-${reserved.sessionId}` };
  });
  const pending = vi.fn();
  const hub = {
    snapshot: () => [...sessions.values()],
    session: (id: string) => sessions.get(id),
    workspaces: () => [{ id: 'workspace', root: parentCwd }],
    setPendingSessionSetups: pending,
    sessionService: { create },
    onEvent(listener: (event: HeadlessHubEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HeadlessHub;
  routes = createSessionMcpRoutes({
    headlessHub: hub,
    publicOrigin: () => 'https://host.example',
    authorization,
    registrationStore: createSessionMcpRegistrationStore({ stateDir: path.join(root, 'state') }),
    conversationStore: store,
    isSessionPersisted: (id, cwd) => persisted.get(id) === cwd,
  });
  handlers.push(routes);
  const client = authorization.createClient({ name: 'client', redirectUri: 'https://chatgpt.com/callback' });
  authorization.createAuthorizationBinding({
    clientId: client.clientId,
    sessionId: 'parent',
    sessionGeneration: 1,
    audience,
    scope: 'session',
    routing,
  });
  const mint = () => {
    const code = authorization.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
    });
    return authorization.exchangeToken({
      grantType: 'authorization_code',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: client.redirectUri,
      code: code.code,
      codeVerifier: verifier,
    });
  };
  let token = mint().accessToken;
  const rpc = async (method: string, params?: Record<string, unknown>, requestId: string | number = 1) => {
    const response = await routes.handlePublic(
      new Request(audience, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }),
      }),
    );
    return (await response!.json()) as {
      result?: {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ text: string }>;
        tools?: unknown[];
        resources?: unknown[];
      };
      error?: unknown;
    };
  };
  const cancel = (chat?: string) =>
    routes.handlePublic(
      new Request(audience, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: {
            requestId: 1,
            ...(chat === undefined ? {} : { _meta: { 'openai/session': chat } }),
          },
        }),
      }),
    );
  const call = (chat?: string, name = 'load_context', args: Record<string, unknown> = {}, id: string | number = 1) =>
    rpc(
      'tools/call',
      { name, arguments: args, ...(chat === undefined ? {} : { _meta: { 'openai/session': chat } }) },
      id,
    );
  const host = (method: string, suffix: string, body?: unknown) =>
    routes.handleHost(
      new Request(`https://host.example${routePath}${suffix}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const setup = async (id: string) => {
    const cwd = path.join(root, id);
    fs.mkdirSync(cwd, { recursive: true });
    expect((await host('POST', `/conversations/${id}`, { cwd }))!.status).toBe(200);
    return cwd;
  };
  return {
    root,
    parentCwd,
    store,
    surfaces,
    sessions,
    persisted,
    authorization,
    routes,
    create,
    pending,
    rpc,
    call,
    host,
    setup,
    addSession,
    renew: () => {
      token = mint().accessToken;
    },
    client,
    cancel,
  };
}

describe('conversation-bound Session MCP routing', () => {
  it('does not create runtimes during discovery, missing identity, or concurrent first calls', async () => {
    const f = fixture();
    await f.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    await f.rpc('tools/list');
    expect(f.store.list()).toHaveLength(0);
    expect((await f.call()).result?.structuredContent?.code).toBe('CONVERSATION_ID_REQUIRED');
    const first = await Promise.all([f.call('a'), f.call('a', 'load_context', {}, 2), f.call('b')]);
    expect(first.every((result) => result.result?.structuredContent?.code === 'SESSION_SETUP_REQUIRED')).toBe(true);
    expect(first[0].result?.structuredContent?.bindingId).toBe(first[1].result?.structuredContent?.bindingId);
    expect(f.store.list()).toHaveLength(2);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.surfaces.get('parent')!.invokeTool).not.toHaveBeenCalled();
  });

  it('routes contexts, file writes, and skills into two separate session surfaces', async () => {
    const f = fixture();
    await f.rpc('tools/list');
    await f.call('a');
    await f.call('b');
    const [a, b] = f.store.list();
    const aCwd = await f.setup(a.id);
    const bCwd = await f.setup(b.id);
    expect((await f.call('a')).result?.structuredContent).toMatchObject({ sessionId: a.id, cwd: aCwd });
    expect((await f.call('b')).result?.structuredContent).toMatchObject({ sessionId: b.id, cwd: bCwd });
    await Promise.all([
      f.call('a', 'write', { path: 'same.txt', text: 'A' }),
      f.call('b', 'write', { path: 'same.txt', text: 'B' }),
    ]);
    expect(fs.readFileSync(path.join(aCwd, 'same.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(bCwd, 'same.txt'), 'utf8')).toBe('B');
    expect(fs.existsSync(path.join(f.parentCwd, 'same.txt'))).toBe(false);
    expect((await f.call('a', 'load_skill')).result?.content?.[0].text).toBe(`guide for ${a.id}`);
    expect((await f.rpc('resources/list')).result?.resources).toEqual([]);
    expect((await f.rpc('resources/read', { uri: 'doompi://session/parent/guide' })).error).toBeDefined();
    expect(f.surfaces.get('parent')!.invokeTool).not.toHaveBeenCalled();
  });

  it('deduplicates setup and refuses shared, nested, or symlink-aliased directories', async () => {
    const f = fixture();
    await f.call('a');
    const record = f.store.list()[0];
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.parentCwd, alias, 'dir');
    for (const cwd of [f.parentCwd, path.join(f.parentCwd, 'nested'), alias])
      expect((await f.host('POST', `/conversations/${record.id}`, { cwd }))!.status).toBe(409);
    const cwd = path.join(f.root, 'independent');
    fs.mkdirSync(cwd);
    const responses = await Promise.all([
      f.host('POST', `/conversations/${record.id}`, { cwd }),
      f.host('POST', `/conversations/${record.id}`, { cwd }),
    ]);
    expect(responses.every((response) => response!.status === 200)).toBe(true);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.store.get(record.id, 'parent').state).toBe('bound');
  });

  it('retains targets through child restart and authorization renewal without recreating dormant or closed sessions', async () => {
    const f = fixture();
    await f.call('a');
    const record = f.store.list()[0];
    const cwd = await f.setup(record.id);
    f.addSession(record.id, cwd, 'parent');
    f.renew();
    expect((await f.call('a')).result?.structuredContent?.sessionId).toBe(record.id);
    f.sessions.delete(record.id);
    expect((await f.call('a')).result?.structuredContent?.code).toBe('SESSION_UNAVAILABLE');
    expect((await f.host('POST', `/conversations/${record.id}`, { cwd }))!.status).toBe(409);
    f.routes.closeSessionBinding(record.id);
    expect((await f.call('a')).result?.structuredContent?.code).toBe('SESSION_UNAVAILABLE');
    expect(f.create).toHaveBeenCalledOnce();
    expect(fs.existsSync(cwd)).toBe(true);
  });

  it('rejects changed target contracts and revoked registrations', async () => {
    const f = fixture();
    await f.call('a');
    const record = f.store.list()[0];
    await f.setup(record.id);
    const surface = f.surfaces.get(record.id)!;
    const original = surface.readSurface();
    surface.readSurface = () => ({
      ...original,
      tools: original.tools.map((tool) => ({ ...tool, parameters: Type.Object({ unexpected: Type.String() }) })),
    });
    expect((await f.call('a')).result?.structuredContent?.code).toBe('SESSION_TOOL_SURFACE_CHANGED');
    expect(surface.invokeTool).not.toHaveBeenCalled();
    expect((await f.host('DELETE', `/clients/${f.client.clientId}`))!.status).toBe(200);
    expect((await f.call('a')).error).toBeDefined();
    expect(f.store.list()[0].state).toBe('closed');
  });

  it('requires explicit verification to create conversation-mode clients and keeps direct mode unchanged', async () => {
    const f = fixture('session');
    expect((await f.call()).result?.structuredContent?.sessionId).toBe('parent');
    expect(f.store.list()).toHaveLength(0);
    const input = { redirectUri: 'https://chatgpt.com/callback', scope: 'session', routing: 'conversation' };
    expect((await f.host('POST', '/clients', input))!.status).toBe(400);
    expect((await f.host('POST', '/clients', { ...input, conversationIdentityVerified: true }))!.status).toBe(201);
    expect(
      (await f.host('POST', '/clients', { ...input, routing: 'unknown', conversationIdentityVerified: true }))!.status,
    ).toBe(400);
  });
  it('preserves the association when the parent restarts and the client reauthorizes', async () => {
    const f = fixture();
    await f.call('a');
    const record = f.store.list()[0];
    await f.setup(record.id);
    f.addSession('parent', f.parentCwd);
    expect((await f.call('a')).error).toBeDefined();
    f.renew();
    expect((await f.call('a')).result?.structuredContent?.sessionId).toBe(record.id);
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('does not cancel another conversation when request IDs collide or metadata is omitted', async () => {
    const f = fixture();
    await f.call('a');
    await f.call('b');
    const [a, b] = f.store.list();
    await f.setup(a.id);
    await f.setup(b.id);
    const signals = new Map<string, AbortSignal>();
    const releases = new Map<string, () => void>();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    for (const record of [a, b]) {
      f.surfaces.get(record.id)!.invokeTool = async (invocation) =>
        new Promise((resolve) => {
          signals.set(record.id, invocation.signal!);
          const release = () => resolve({ content: [{ type: 'text', text: 'settled' }] });
          releases.set(record.id, release);
          invocation.signal!.addEventListener('abort', release, { once: true });
          if (signals.size === 2) ready();
        });
    }
    const calls = [f.call('a'), f.call('b')];
    try {
      await started;
      await f.cancel();
      expect(signals.get(a.id)!.aborted).toBe(false);
      expect(signals.get(b.id)!.aborted).toBe(false);
      await f.cancel('a');
      expect(signals.get(a.id)!.aborted).toBe(true);
      expect(signals.get(b.id)!.aborted).toBe(false);
      await calls[0];
      await f.cancel();
      expect(signals.get(b.id)!.aborted).toBe(false);
    } finally {
      for (const release of releases.values()) release();
      await Promise.all(calls);
    }
  });
});
