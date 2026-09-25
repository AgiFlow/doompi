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
import type {
  SessionToolDescriptor,
  SessionToolInvocation,
  SessionToolSurface,
} from '../../../../../src/types/server/sessionToolSurface';

const roots: string[] = [];
const routePath = '/api/workspaces/workspace/sessions/parent/mcp';
const audience = `https://host.example${routePath}`;
const verifier = 'v'.repeat(43);
const handlers: SessionMcpRoutes[] = [];
afterEach(() => {
  for (const routes of handlers.splice(0)) routes.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const UI_URI = 'ui://doompi/session/v1/index.html';

function fixture(_routing: unknown = 'conversation', withUi = false, automatic = false) {
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
        tools: ['write', 'load_context', 'load_skill', ...(withUi ? ['show_session'] : [])].map((name) => ({
          name,
          label: name,
          description: name,
          parameters: Type.Object({ path: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
          ...(name === 'show_session'
            ? { _meta: { ui: { resourceUri: UI_URI, visibility: ['model' as const, 'app' as const] } } }
            : {}),
        })),
        skills: [{ name: 'guide', description: 'Target guide', uri: `doompi://session/${id}/guide` }],
        uiResources: withUi ? [{ uri: UI_URI, name: 'Session', mimeType: 'text/html;profile=mcp-app' }] : [],
      }),
      invokeTool: vi.fn(async (invocation: SessionToolInvocation) => {
        await invocation.authorize?.();
        if (invocation.name === 'write')
          fs.writeFileSync(path.join(cwd, String(invocation.arguments.path)), String(invocation.arguments.text));
        const text =
          invocation.name === 'load_skill'
            ? await invocation.mcpSkills!.read(
                typeof invocation.arguments.name === 'string' ? invocation.arguments.name : 'guide',
              )
            : id;
        return { content: [{ type: 'text' as const, text }], structuredContent: { sessionId: id, cwd } };
      }),
      readSkill: (_revision, uri) => (uri === 'doompi://child-guide' ? '# child guidance' : `guide for ${id}`),
      readUiResource: vi.fn(() => '<!doctype html><title>Static session view</title>'),
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
  const provisionReservedWorktree = vi.fn(
    async ({ reservationId, parentSessionId }: { reservationId: string; parentSessionId: string }) => {
      const cwd = path.join(root, 'worktrees', reservationId);
      fs.mkdirSync(cwd, { recursive: true });
      await routes.reservations.prepare(reservationId, parentSessionId, cwd);
      await create({
        cwd,
        name: `conversation ${reservationId.slice(0, 8)}`,
        parentSessionId,
        reservationId,
        sessionProvenance: 'worktree',
      });
      return routes.reservations.complete(reservationId, parentSessionId);
    },
  );
  const hub = {
    snapshot: () => [...sessions.values()],
    session: (id: string) => sessions.get(id),
    workspaces: () => [{ id: 'workspace', root: parentCwd }],
    setPendingSessionSetups: pending,
    sessionService: { create, ...(automatic ? { provisionReservedWorktree } : {}) },
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
    routing: 'conversation',
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
  it('prefetches static UI without allocating a child or exposing session guidance', async () => {
    const f = fixture('conversation', true);
    expect((await f.rpc('resources/list')).result?.resources).toEqual([
      { uri: UI_URI, name: 'Session', mimeType: 'text/html;profile=mcp-app' },
    ]);
    expect(await f.rpc('resources/read', { uri: UI_URI })).toMatchObject({
      result: {
        contents: [
          {
            uri: UI_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: '<!doctype html><title>Static session view</title>',
          },
        ],
      },
    });
    expect((await f.rpc('resources/read', { uri: 'doompi://session/parent/guide' })).error).toBeDefined();
    expect(f.store.list()).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.surfaces.get('parent')!.invokeTool).not.toHaveBeenCalled();
  });

  it('keeps widget calls and refreshes bound to their own conversations', async () => {
    const f = fixture('conversation', true);
    expect((await f.call(undefined, 'show_session')).result?.structuredContent?.code).toBe('CONVERSATION_ID_REQUIRED');
    const firstA = await f.call('chat-a', 'show_session');
    const firstB = await f.call('chat-b', 'show_session');
    await f.setup(String(firstA.result!.structuredContent!.bindingId));
    await f.setup(String(firstB.result!.structuredContent!.bindingId));
    const a = await f.call('chat-a', 'show_session');
    const b = await f.call('chat-b', 'show_session');
    expect(a.result?.isError).toBe(false);
    expect(b.result?.isError).toBe(false);
    expect(a.result?.structuredContent?.sessionId).not.toBe(b.result?.structuredContent?.sessionId);
    expect(a.result?.structuredContent?.sessionId).not.toBe('parent');
    expect((await f.call('chat-a', 'show_session')).result?.structuredContent).toEqual(a.result?.structuredContent);
    expect((await f.call('chat-b', 'show_session')).result?.structuredContent).toEqual(b.result?.structuredContent);
    expect(f.surfaces.get('parent')!.invokeTool).not.toHaveBeenCalled();
  });

  it('rejects a child with a different UI tool contract', async () => {
    const f = fixture('conversation', true);
    const first = await f.call('chat-a', 'show_session');
    await f.setup(String(first.result!.structuredContent!.bindingId));
    const ready = await f.call('chat-a', 'show_session');
    const surface = f.surfaces.get(String(ready.result!.structuredContent!.sessionId))!;
    const snapshot = surface.readSurface();
    surface.readSurface = () => ({
      ...snapshot,
      tools: snapshot.tools.map((tool) =>
        tool.name === 'show_session'
          ? { ...tool, _meta: { ui: { resourceUri: 'ui://doompi/session/v2/index.html' } } }
          : tool,
      ),
    });
    expect((await f.call('chat-a', 'show_session')).result?.structuredContent?.code).toBe(
      'SESSION_TOOL_SURFACE_CHANGED',
    );
    expect(surface.invokeTool).toHaveBeenCalledTimes(1);
  });
  it('automatically creates one separate worktree runtime per conversation', async () => {
    const f = fixture('conversation', false, true);
    await f.rpc('tools/list');
    expect(f.store.list()).toHaveLength(0);
    expect((await f.call()).result?.structuredContent?.code).toBe('CONVERSATION_ID_REQUIRED');
    const first = await Promise.all([f.call('a'), f.call('a', 'load_context', {}, 2), f.call('b')]);
    expect(first.every((result) => result.result?.isError === false)).toBe(true);
    expect(f.store.list()).toHaveLength(2);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.store.list().every((record) => record.state === 'bound')).toBe(true);
    expect(f.store.list().every((record) => record.cwd?.startsWith(path.join(f.root, 'worktrees')))).toBe(true);
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

  it('discovers child-only tools and skills without changing the parent tools/list catalog', async () => {
    const f = fixture();
    const listed = (await f.rpc('tools/list')).result!.tools as { name: string }[];
    expect(listed.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['load_extra_tools', 'use_extra_tools', 'load_context', 'load_skill']),
    );
    expect(listed.some((tool) => tool.name === 'child_action')).toBe(false);
    expect(f.store.list()).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();

    const first = await f.call('a', 'load_extra_tools', {});
    const record = f.store.list()[0];
    expect(first.result?.isError).toBe(true);
    expect(first.result?.structuredContent?.bindingId).toBe(record.id);
    await f.setup(record.id);
    const child = f.surfaces.get(record.id)!;
    const original = child.readSurface();
    const childTool: SessionToolDescriptor = {
      name: 'child_action',
      label: 'Child action',
      description: 'Only available in this conversation',
      parameters: Type.Object({ message: Type.String() }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ['model'] } },
    };
    child.readSurface = () => ({
      ...original,
      tools: [...original.tools, childTool],
      skills: [...original.skills, { name: 'child-guide', description: 'Child guidance', uri: 'doompi://child-guide' }],
    });
    const discovered = await f.call('a', 'load_extra_tools', {});
    expect(discovered.result?.isError).toBe(false);
    expect(discovered.result?.structuredContent).toEqual({
      tools: [
        {
          name: childTool.name,
          title: childTool.label,
          description: childTool.description,
          inputSchema: childTool.parameters,
          annotations: childTool.annotations,
          _meta: childTool._meta,
        },
      ],
      skills: [{ name: 'child-guide', description: 'Child guidance' }],
    });
    expect(
      (await f.call('a', 'use_extra_tools', { name: 'child_action', arguments: { message: 'hello' } })).result,
    ).toMatchObject({ isError: false, structuredContent: { sessionId: record.id } });
    expect(child.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'child_action',
        arguments: { message: 'hello' },
      }),
    );
    expect((await f.call('a', 'load_skill')).result?.content?.[0].text).toBe(`guide for ${record.id}`);
    expect((await f.call('a', 'load_skill', { name: 'child-guide' })).result?.content?.[0].text).toBe(
      '# child guidance',
    );
    expect(child.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'load_skill', arguments: { name: 'child-guide' } }),
    );
    expect(f.surfaces.get('parent')!.invokeTool).not.toHaveBeenCalled();
    expect(
      ((await f.rpc('tools/list')).result!.tools as { name: string }[]).some((tool) => tool.name === 'child_action'),
    ).toBe(false);
  });

  it('refreshes the parent baseline and isolates or withdraws conversation extras', async () => {
    const f = fixture();
    await f.rpc('tools/list');
    await f.call('a');
    await f.call('b');
    const [a, b] = f.store.list();
    await f.setup(a.id);
    await f.setup(b.id);
    const parent = f.surfaces.get('parent')!;
    const aSurface = f.surfaces.get(a.id)!;
    const bSurface = f.surfaces.get(b.id)!;
    const originalParent = parent.readSurface();
    const originalA = aSurface.readSurface();
    const originalB = bSurface.readSurface();
    const aTool: SessionToolDescriptor = {
      name: 'a_only',
      label: 'A only',
      description: 'Only in A',
      parameters: Type.Object({}),
    };
    aSurface.readSurface = () => ({ ...originalA, tools: [...originalA.tools, aTool] });
    expect((await f.call('a', 'load_extra_tools', {})).result?.structuredContent?.tools).toEqual([
      expect.objectContaining({ name: 'a_only' }),
    ]);
    expect((await f.call('b', 'load_extra_tools', {})).result?.structuredContent).toEqual({ tools: [], skills: [] });
    const rejected = await f.call('b', 'use_extra_tools', { name: 'a_only' });
    expect(rejected.result?.isError === true || rejected.error !== undefined).toBe(true);
    expect(bSurface.invokeTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'a_only' }));

    parent.readSurface = () => ({ ...originalParent, tools: [...originalParent.tools, aTool] });
    expect((await f.call('a', 'load_extra_tools', {})).result?.structuredContent?.tools).toEqual([
      expect.objectContaining({ name: 'a_only' }),
    ]);
    await f.rpc('tools/list');
    expect((await f.call('a', 'load_extra_tools', {})).result?.structuredContent).toEqual({ tools: [], skills: [] });
    aSurface.readSurface = () => originalA;
    expect((await f.call('a', 'load_extra_tools', {})).result?.structuredContent).toEqual({ tools: [], skills: [] });
    const withdrawn = await f.call('a', 'use_extra_tools', { name: 'a_only' });
    expect(withdrawn.result?.isError === true || withdrawn.error !== undefined).toBe(true);
    expect(aSurface.invokeTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'a_only' }));
    bSurface.readSurface = () => originalB;
    expect(f.surfaces.get('parent')!.invokeTool).not.toHaveBeenCalled();
  });
  it('retains a signed URL baseline across independent HTTP handlers', async () => {
    const f = fixture();
    const created = await f.host('POST', '/clients', { authMethod: 'url_token', scope: 'session' });
    expect(created!.status).toBe(201);
    const { client } = (await created!.json()) as { client: { connectionUrl: string } };
    const signed = async (method: string, params?: Record<string, unknown>) => {
      const response = await f.routes.handlePublic(
        new Request(client.connectionUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
        }),
      );
      return (await response!.json()) as {
        result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      };
    };
    const call = () =>
      signed('tools/call', {
        name: 'load_extra_tools',
        arguments: {},
        _meta: { 'openai/session': 'signed-chat' },
      });
    expect((await call()).result?.structuredContent?.code).toBe('SESSION_MCP_BASELINE_REQUIRED');
    await signed('tools/list');
    const pending = await call();
    expect(pending.result?.isError).toBe(true);
    await f.setup(f.store.list()[0]!.id);
    expect((await call()).result?.structuredContent).toEqual({ tools: [], skills: [] });
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

  it('normalizes legacy registrations to mandatory conversation routing', async () => {
    const f = fixture('session');
    expect((await f.call()).result?.structuredContent?.code).toBe('CONVERSATION_ID_REQUIRED');
    expect(f.store.list()).toHaveLength(0);
    const input = { redirectUri: 'https://chatgpt.com/callback', scope: 'session', routing: 'conversation' };
    expect((await f.host('POST', '/clients', input))!.status).toBe(201);
    expect((await f.host('POST', '/clients', { ...input, routing: 'unknown' }))!.status).toBe(400);
  });
  it('creates host-only API keys, persists before revealing them, and revokes conversation access', async () => {
    const f = fixture('conversation', false, true);
    const input = { authMethod: 'api_key', name: 'External MCP', scope: 'session', routing: 'conversation' };
    for (const invalid of [
      { ...input, redirectUri: 'https://chatgpt.com/callback' },
      { ...input, scope: 'restricted', tools: [], skills: [] },
      { ...input, routing: 'unknown' },
      { ...input, authMethod: 'unknown' },
    ])
      expect((await f.host('POST', '/clients', invalid))!.status).toBe(400);
    const created = (await (await f.host('POST', '/clients', input))!.json()) as {
      client: { clientId: string; clientSecret: string; tokenEndpointAuthMethod: string; redirectUri: string };
    };
    expect(created.client).toMatchObject({ tokenEndpointAuthMethod: 'api_key', redirectUri: '' });
    const listed = (await (await f.host('GET', '/clients'))!.json()) as { clients: Record<string, unknown>[] };
    expect(listed.clients).toHaveLength(2);
    expect(listed.clients[1]).not.toHaveProperty('clientSecret');
    const stored = fs.readFileSync(path.join(f.root, 'state', 'session-mcp-registrations.json'), 'utf8');
    expect(stored).not.toContain(created.client.clientSecret);
    expect(f.authorization.authenticateAccessToken(created.client.clientSecret, audience)).toBeDefined();
    expect(f.authorization.authenticateAccessToken(created.client.clientSecret, `${audience}/other`)).toBeUndefined();
    const saveSpy = vi.spyOn(fs, 'renameSync');
    const response = await f.routes.handlePublic(
      new Request(audience, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${created.client.clientSecret}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(response!.status).toBe(200);
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
    const body = (await response!.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toContain('write');
    expect((await f.host('DELETE', `/clients/${created.client.clientId}`))!.status).toBe(200);
    expect(f.authorization.authenticateAccessToken(created.client.clientSecret, audience)).toBeUndefined();
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
