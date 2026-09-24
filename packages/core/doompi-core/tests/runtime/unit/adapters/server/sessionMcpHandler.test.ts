import { createHash } from 'node:crypto';

import {
  InitializeResultSchema,
  JSONRPCResponseSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { createSessionMcpHttpHandler } from '../../../../../src/server/sessionMcpHandler';
import { createSessionMcpAuthorizationService } from '../../../../../src/services/sessionMcpAuthorization';
import type { SessionToolSurface } from '../../../../../src/types/server/sessionToolSurface';

const AUDIENCE = 'https://host.example/sessions/alpha/mcp';
const VERIFIER = 'v'.repeat(43);
const UI_RESOURCE = {
  uri: 'ui://doompi/test/v1/index.html',
  name: 'Session view',
  mimeType: 'text/html;profile=mcp-app' as const,
  _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
};
const ACTIVITY_RESOURCE = {
  ...UI_RESOURCE,
  uri: 'ui://doompi/activity/v1/index.html',
  name: 'Tool activity',
  _meta: { ...UI_RESOURCE._meta, 'doompi/defaultToolUi': true },
};
function rpcResult(body: unknown) {
  const response = JSONRPCResponseSchema.parse(body);
  if ('error' in response) throw new Error(response.error.message);
  return response.result;
}

function fixture(scope: 'restricted' | 'session' = 'restricted') {
  const authorization = createSessionMcpAuthorizationService();
  const mint = (generation = 7) => {
    const client = authorization.createClient({ name: 'MCP client', redirectUri: 'https://client.example/callback' });
    const binding = {
      clientId: client.clientId,
      sessionId: 'alpha',
      sessionGeneration: generation,
      audience: AUDIENCE,
    };
    authorization.createAuthorizationBinding(
      scope === 'session'
        ? { ...binding, scope: 'session' }
        : { ...binding, tools: ['allowed_tool'], skills: ['allowed-skill'] },
    );
    const code = authorization.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
      codeChallengeMethod: 'S256',
    });
    const tokens = authorization.exchangeToken({
      grantType: 'authorization_code',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code: code.code,
      redirectUri: client.redirectUri,
      codeVerifier: VERIFIER,
    });
    return { ...tokens, grantId: code.grant.id, client };
  };
  const tokens = mint();
  const invokeTool = vi.fn<SessionToolSurface['invokeTool']>(async (_invocation) => ({
    content: [{ type: 'text' as const, text: 'called' }],
  }));
  const readSkill = vi.fn(async () => '# Allowed skill');
  const readUiResource = vi.fn(async () => '<!doctype html><title>Session</title>');
  const onNotice = vi.fn();
  let uiEnabled = false;
  let activityEnabled = false;
  let revision = 12;
  let includeNewCapabilities = false;
  const toolSurface: SessionToolSurface = {
    readSurface: () => ({
      revision,
      tools: [
        {
          name: 'allowed_tool',
          label: 'Allowed tool',
          description: 'May run',
          parameters: Type.Object({}),
          annotations: { readOnlyHint: true, openWorldHint: false },
          outputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
          ...(uiEnabled
            ? {
                _meta: {
                  ui: { resourceUri: UI_RESOURCE.uri, visibility: ['model' as const, 'app' as const] },
                  'openai/outputTemplate': UI_RESOURCE.uri,
                },
              }
            : {}),
        },
        {
          name: 'hidden_tool',
          label: 'Hidden tool',
          description: 'Must not leak',
          parameters: Type.Object({}),
          ...(uiEnabled ? { _meta: { ui: { resourceUri: 'ui://doompi/hidden/v1/index.html' } } } : {}),
        },
        ...(includeNewCapabilities
          ? [{ name: 'new_tool', label: 'New tool', description: 'Newly enabled', parameters: Type.Object({}) }]
          : []),
      ],
      skills: [
        { name: 'allowed-skill', description: 'May read', uri: 'doompi://session/alpha/skills/allowed-skill' },
        { name: 'hidden-skill', description: 'Must not leak', uri: 'doompi://session/alpha/skills/hidden-skill' },
        ...(includeNewCapabilities
          ? [{ name: 'new-skill', description: 'Newly enabled', uri: 'doompi://session/alpha/skills/new-skill' }]
          : []),
      ],
      uiResources: [
        ...(uiEnabled ? [UI_RESOURCE, { ...UI_RESOURCE, uri: 'ui://doompi/hidden/v1/index.html' }] : []),
        ...(activityEnabled ? [ACTIVITY_RESOURCE] : []),
      ],
    }),
    invokeTool,
    readSkill,
    readUiResource,
  };
  let generation = 7;
  let resolveCount = 0;
  let revokeAtResolve = -1;
  const handler = createSessionMcpHttpHandler({
    audience: AUDIENCE,
    authorization,
    onNotice,
    resolveSession: async () => {
      resolveCount += 1;
      if (resolveCount === revokeAtResolve) authorization.revokeGrant(tokens.grantId);
      return { generation, toolSurface };
    },
    resolveConversation: async () => ({ generation, toolSurface }),
  });
  const request = (
    method: string,
    params?: Record<string, unknown>,
    token = tokens.accessToken,
    signal?: AbortSignal,
    id: string | number | undefined = 1,
  ) =>
    handler(
      new Request(AUDIENCE, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined
            ? {}
            : {
                params:
                  method === 'tools/call' || method === 'resources/read'
                    ? { ...params, _meta: { 'openai/session': 'test' } }
                    : params,
              }),
        }),
      }),
    );
  return {
    authorization,
    mint,
    notify: (requestId: string | number, token = tokens.accessToken) =>
      handler(
        new Request(AUDIENCE, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId, _meta: { 'openai/session': 'test' } },
          }),
        }),
      ),
    handler,
    request,
    invokeTool,
    onNotice,
    readSkill,
    readUiResource,
    toolSurface,
    setActivityEnabled: (value: boolean) => (activityEnabled = value),
    setUiEnabled: (value: boolean) => (uiEnabled = value),
    grantId: tokens.grantId,
    setGeneration: (value: number) => (generation = value),
    enableNewCapabilities: () => {
      includeNewCapabilities = true;
      revision = 13;
    },
    revokeDuringNextOperation: () => (revokeAtResolve = resolveCount + 2),
  };
}

describe('session MCP Streamable HTTP handler', () => {
  it.each([
    'read',
    'write',
    'edit',
    'grep',
    'find',
    'ls',
    'bash',
    'task',
    'load_context',
    'search_skills',
    'load_skill',
    'mcp_use',
    'computer_state',
    'computer_action',
    'computer_exec',
    'complete_plan',
    'record_debug_evidence',
    'run_fable_plan',
    'write_plan',
    'future_tool',
  ])('adds an activity widget to %s without changing its contract or permissions', async (name) => {
    const f = fixture('session');
    f.setActivityEnabled(true);
    const snapshot = f.toolSurface.readSurface();
    const original = { ...snapshot.tools[0]!, name };
    vi.spyOn(f.toolSurface, 'readSurface').mockReturnValue({ ...snapshot, tools: [original] });
    const result = ListToolsResultSchema.parse(rpcResult(await (await f.request('tools/list')).json()));
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      name,
      inputSchema: original.parameters,
      outputSchema: original.outputSchema,
      annotations: original.annotations,
      _meta: {
        ui: { resourceUri: ACTIVITY_RESOURCE.uri, visibility: ['model'] },
        'openai/outputTemplate': ACTIVITY_RESOURCE.uri,
      },
    });
    expect(original._meta).toBeUndefined();
  });

  it('preserves native results and limits widget context to bounded safe input fields', async () => {
    const f = fixture();
    f.setActivityEnabled(true);
    const native = {
      content: [{ type: 'text' as const, text: 'original output' }],
      structuredContent: { status: 'ok' },
      _meta: { privateDetail: 'preserved' },
      isError: false,
    };
    f.invokeTool.mockResolvedValue(native);
    const body = rpcResult(
      await (
        await f.request('tools/call', {
          name: 'allowed_tool',
          arguments: {
            path: 'src/file.ts',
            pattern: 'x'.repeat(1000),
            content: 'private file contents',
            command: 'TOKEN=secret run',
            password: 'secret',
            arguments: { token: 'secret' },
          },
        })
      ).json(),
    );
    expect(body).toMatchObject({
      ...native,
      _meta: {
        ...native._meta,
        'doompi/toolActivity': {
          tool: 'allowed_tool',
          title: 'Allowed tool',
          input: { path: 'src/file.ts', pattern: `${'x'.repeat(500)}...` },
          durationMs: expect.any(Number),
        },
      },
    });
    expect(JSON.stringify(body._meta)).not.toContain('secret');
    expect(JSON.stringify(body._meta)).not.toContain('private file contents');
    f.invokeTool.mockResolvedValue({ content: [{ type: 'text', text: 'Write failed' }], isError: true });
    const failed = rpcResult(await (await f.request('tools/call', { name: 'allowed_tool' })).json());
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Write failed' }],
      _meta: { 'doompi/toolActivity': { tool: 'allowed_tool' } },
    });
  });

  it('serves only referenced fallback resources and keeps custom widgets authoritative', async () => {
    const f = fixture();
    f.setActivityEnabled(true);
    const resources = rpcResult(await (await f.request('resources/list')).json());
    expect(resources.resources).toEqual([ACTIVITY_RESOURCE]);
    const read = rpcResult(await (await f.request('resources/read', { uri: ACTIVITY_RESOURCE.uri })).json());
    expect(read.contents).toEqual([{ ...ACTIVITY_RESOURCE, text: '<!doctype html><title>Session</title>' }]);
    f.setUiEnabled(true);
    const tools = ListToolsResultSchema.parse(rpcResult(await (await f.request('tools/list')).json()));
    expect(tools.tools[0]?._meta?.ui).toEqual({ resourceUri: UI_RESOURCE.uri, visibility: ['model', 'app'] });
    expect(tools.tools[0]?._meta?.['doompi/toolActivity']).toBeUndefined();
    expect(rpcResult(await (await f.request('resources/list')).json()).resources).toEqual([UI_RESOURCE]);
    const denied = await (await f.request('resources/read', { uri: ACTIVITY_RESOURCE.uri })).json();
    expect(denied).toMatchObject({ error: { message: expect.stringContaining('not granted or active') } });
    const native = { content: [{ type: 'text' as const, text: 'custom' }], _meta: { custom: true }, isError: false };
    f.invokeTool.mockResolvedValue(native);
    expect(rpcResult(await (await f.request('tools/call', { name: 'allowed_tool' })).json())).toEqual(native);
  });

  it('does not expose an unused or ambiguous activity resource', async () => {
    const f = fixture();
    f.setActivityEnabled(true);
    const snapshot = f.toolSurface.readSurface();
    const read = vi.spyOn(f.toolSurface, 'readSurface').mockReturnValue({ ...snapshot, tools: [] });
    expect(rpcResult(await (await f.request('resources/list')).json()).resources).toEqual([]);
    read.mockReturnValue({
      ...snapshot,
      uiResources: [ACTIVITY_RESOURCE, { ...ACTIVITY_RESOURCE, uri: 'ui://other/default' }],
    });
    const tools = ListToolsResultSchema.parse(rpcResult(await (await f.request('tools/list')).json()));
    expect(tools.tools[0]?._meta?.ui).toEqual({ visibility: ['model'] });
    expect(rpcResult(await (await f.request('resources/list')).json()).resources).toEqual([]);
  });
  it('advertises a self-contained bootstrap without needing plugin resources', async () => {
    const { request } = fixture();
    const response = await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1' },
    });
    const result = InitializeResultSchema.parse(rpcResult(await response.json()));
    expect(result.instructions?.length).toBeLessThanOrEqual(512);
    expect(result.instructions).toContain('load_context');
    expect(result.instructions).toContain('load_skill');
    expect(result.instructions).toContain('Saving a plan does not authorize implementation');
  });

  it('preserves public MCP metadata and structured errors without exporting internal details', async () => {
    const { request, invokeTool } = fixture();
    const listing = ListToolsResultSchema.parse(rpcResult(await (await request('tools/list')).json()));
    expect(listing.tools).toHaveLength(1);
    expect(listing.tools[0]).toMatchObject({
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: { type: 'object', required: ['status'] },
      _meta: { ui: { visibility: ['model'] } },
    });
    for (const isError of [false, true]) {
      invokeTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'A readable result' }],
        structuredContent: { status: isError ? 'failed' : 'completed' },
        _meta: { widgetType: 'session', displayLabel: 'Component only' },
        details: { internalToken: 'never-export' },
        isError,
      });
      const response = rpcResult(await (await request('tools/call', { name: 'allowed_tool' })).json());
      expect(response).toEqual({
        content: [{ type: 'text', text: 'A readable result' }],
        structuredContent: { status: isError ? 'failed' : 'completed' },
        _meta: { widgetType: 'session', displayLabel: 'Component only' },
        isError,
      });
      expect(JSON.stringify(response)).not.toContain('never-export');
    }
  });

  it('requires an exact Bearer credential and exact audience URL', async () => {
    const { handler } = fixture();

    const missing = await handler(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const basic = await handler(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(basic.status).toBe(401);

    const wrongAudience = await handler(
      new Request(`${AUDIENCE}?token=ignored`, {
        method: 'POST',
        headers: { authorization: 'Bearer ignored', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(wrongAudience.status).toBe(404);
    expect(() =>
      createSessionMcpHttpHandler({
        audience: `${AUDIENCE}?resource=other`,
        authorization: fixture().authorization,
        resolveSession: () => undefined,
      }),
    ).toThrow('without credentials, a query, or a fragment');
  });
  it('accepts an exact signed URL JWT without an Authorization header', async () => {
    const authorization = createSessionMcpAuthorizationService();
    const client = authorization.createClient({ name: 'ChatGPT signed URL', authMethod: 'url_token' });
    authorization.createAuthorizationBinding({
      clientId: client.clientId,
      sessionId: 'alpha',
      sessionGeneration: 7,
      audience: AUDIENCE,
      scope: 'session',
      routing: 'conversation',
    });
    const token = authorization.issueUrlToken(client.clientId);
    const resource = `${AUDIENCE}/${token}`;
    const toolSurface: SessionToolSurface = {
      readSurface: () => ({ revision: 1, tools: [], skills: [] }),
      invokeTool: vi.fn(),
      readSkill: vi.fn(),
    };
    const handler = createSessionMcpHttpHandler({
      audience: AUDIENCE,
      authorization,
      pathToken: token,
      resolveSession: () => ({ generation: 7, toolSurface }),
    });
    const response = await handler(
      new Request(resource, {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ result: { tools: [] } });

    const wrongPath = await handler(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(wrongPath.status).toBe(404);

    const parts = token.split('.');
    const invalidToken = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;
    const invalidHandler = createSessionMcpHttpHandler({
      audience: AUDIENCE,
      authorization,
      pathToken: invalidToken,
      resolveSession: () => ({ generation: 7, toolSurface }),
    });
    const invalid = await invalidHandler(
      new Request(`${AUDIENCE}/${invalidToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toBeNull();
  });

  it('lists and calls only granted active tools', async () => {
    const { request, invokeTool } = fixture();

    const listed = await request('tools/list');
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      result: { tools: [{ name: 'allowed_tool', title: 'Allowed tool' }] },
    });

    const called = await request('tools/call', { name: 'allowed_tool', arguments: {} });
    await expect(called.json()).resolves.toMatchObject({ result: { content: [{ type: 'text', text: 'called' }] } });
    expect(invokeTool).toHaveBeenCalledWith({
      revision: 12,
      name: 'allowed_tool',
      arguments: {},
      signal: expect.any(AbortSignal),
      mcpSkills: expect.any(Object),
      authorize: expect.any(Function),
    });

    const hidden = await request('tools/call', { name: 'hidden_tool', arguments: {} });
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: -32602 } });
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it('supplies an execution-boundary authorization check that rejects revocation and replacement', async () => {
    for (const change of ['revoke', 'generation'] as const) {
      const current = fixture();
      current.invokeTool.mockImplementationOnce(async (invocation) => {
        if (change === 'revoke') current.authorization.revokeGrant(current.grantId);
        else current.setGeneration(8);
        await invocation.authorize!();
        throw new Error('Execution must not be reached');
      });
      await expect((await current.request('tools/call', { name: 'allowed_tool' })).json()).resolves.toMatchObject({
        error: { message: expect.stringContaining('The session grant is no longer active.') },
      });
    }
  });

  it('emits privacy-safe generated correlation and lifecycle notices for each invocation', async () => {
    const current = fixture();
    await expect((await current.request('tools/call', { name: 'allowed_tool' })).json()).resolves.toMatchObject({
      result: { content: [{ text: 'called' }] },
    });

    const notices = current.onNotice.mock.calls.map(([notice]) => notice);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^session MCP invocation id=[0-9a-f-]{36} lifecycle=started$/u);
    expect(notices[1]).toMatch(/^session MCP invocation id=[0-9a-f-]{36} lifecycle=succeeded$/u);
    expect(notices[0]!.match(/id=([^ ]+)/u)?.[1]).toBe(notices[1]!.match(/id=([^ ]+)/u)?.[1]);
    expect(notices.join('\n')).not.toContain('alpha');
    expect(notices.join('\n')).not.toContain('allowed_tool');
  });

  it('emits a failed lifecycle notice with the same correlation ID', async () => {
    const current = fixture();
    current.invokeTool.mockRejectedValueOnce(new Error('failed'));
    await expect((await current.request('tools/call', { name: 'allowed_tool' })).json()).resolves.toMatchObject({
      error: { code: -32603 },
    });

    const notices = current.onNotice.mock.calls.map(([notice]) => notice);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^session MCP invocation id=[0-9a-f-]{36} lifecycle=started$/u);
    expect(notices[1]).toMatch(/^session MCP invocation id=[0-9a-f-]{36} lifecycle=failed$/u);
    expect(notices[0]!.match(/id=([^ ]+)/u)?.[1]).toBe(notices[1]!.match(/id=([^ ]+)/u)?.[1]);
  });

  it('propagates HTTP request cancellation to the tool signal', async () => {
    const current = fixture();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    current.invokeTool.mockImplementationOnce(async (invocation) => {
      signal = invocation.signal;
      controller.abort();
      return { content: [{ type: 'text', text: 'cancelled' }] };
    });
    await current.request('tools/call', { name: 'allowed_tool' }, undefined, controller.signal);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
  });

  it('isolates cancellation by client, generation, and typed request identity and releases completed identities', async () => {
    const current = fixture();
    const other = current.mint();
    const signals: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    current.invokeTool.mockImplementation(async (invocation) => {
      signals.push(invocation.signal!);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const first = current.request('tools/call', { name: 'allowed_tool' });
    const second = current.request('tools/call', { name: 'allowed_tool' }, other.accessToken);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect((await current.notify(1, 'invalid')).status).toBe(401);
    expect((await current.notify('1')).status).toBe(202);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await expect((await current.request('tools/call', { name: 'allowed_tool' })).json()).resolves.toMatchObject({
      error: { code: -32600 },
    });
    expect((await current.notify(1)).status).toBe(202);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    current.setGeneration(8);
    expect((await current.notify(1, other.accessToken)).status).toBe(401);
    const replacement = current.mint(8);
    // Model the same authenticated client in a later generation independently of OAuth binding policy.
    const authenticate = current.authorization.authenticateAccessToken.bind(current.authorization);
    vi.spyOn(current.authorization, 'authenticateAccessToken').mockImplementation((token, audience) => {
      const grant = authenticate(token, audience);
      return grant !== undefined && token === replacement.accessToken
        ? { ...grant, clientId: other.client.clientId }
        : grant;
    });
    expect((await current.notify(1, replacement.accessToken)).status).toBe(202);
    expect(signals[1].aborted).toBe(false);
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    current.setGeneration(7);
    current.invokeTool.mockResolvedValue({ content: [{ type: 'text', text: 'reused' }] });
    await expect((await current.request('tools/call', { name: 'allowed_tool' })).json()).resolves.toMatchObject({
      result: { content: [{ text: 'reused' }] },
    });
    expect((await current.notify(1)).status).toBe(202);
  });

  it('session scope follows capabilities added to the live surface', async () => {
    const session = fixture('session');

    const initial = await session.request('tools/list');
    await expect(initial.json()).resolves.toMatchObject({
      result: { tools: [{ name: 'allowed_tool' }, { name: 'hidden_tool' }] },
    });
    session.enableNewCapabilities();
    const updated = await session.request('tools/list');
    await expect(updated.json()).resolves.toMatchObject({
      result: { tools: [{ name: 'allowed_tool' }, { name: 'hidden_tool' }, { name: 'new_tool' }] },
    });
    const called = await session.request('tools/call', { name: 'new_tool', arguments: {} });
    await expect(called.json()).resolves.toMatchObject({ result: { content: [{ type: 'text', text: 'called' }] } });

    const resources = await session.request('resources/list');
    await expect(resources.json()).resolves.toMatchObject({ result: { resources: [] } });
  });
  it('lists and reads only granted active skill resources', async () => {
    const { request, readSkill } = fixture();

    const listed = await request('resources/list');
    await expect(listed.json()).resolves.toMatchObject({ result: { resources: [] } });

    const read = await request('resources/read', { uri: 'doompi://session/alpha/skills/allowed-skill' });
    await expect(read.json()).resolves.toMatchObject({
      result: {
        contents: [
          { uri: 'doompi://session/alpha/skills/allowed-skill', mimeType: 'text/markdown', text: '# Allowed skill' },
        ],
      },
    });
    expect(readSkill).toHaveBeenCalledWith(12, 'doompi://session/alpha/skills/allowed-skill');

    const hidden = await request('resources/read', { uri: 'doompi://session/alpha/skills/hidden-skill' });
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it('passes only granted skills to an MCP tool and expires access when the call ends', async () => {
    const current = fixture();
    let captured: Parameters<SessionToolSurface['invokeTool']>[0]['mcpSkills'];
    current.invokeTool.mockImplementationOnce(async (invocation) => {
      captured = invocation.mcpSkills;
      await expect(captured!.list()).resolves.toEqual([{ name: 'allowed-skill', description: 'May read' }]);
      await expect(captured!.read('allowed-skill')).resolves.toBe('# Allowed skill');
      await expect(captured!.read('hidden-skill')).rejects.toMatchObject({ code: -32602 });
      return { content: [{ type: 'text' as const, text: 'called' }] };
    });

    await expect(
      (await current.request('tools/call', { name: 'allowed_tool', arguments: {} })).json(),
    ).resolves.toMatchObject({
      result: { content: [{ text: 'called' }] },
    });
    await expect(captured!.list()).rejects.toMatchObject({ code: -32600 });
  });

  it('rechecks revocation after session resolution and tool invocation await points', async () => {
    const resolving = fixture();
    resolving.revokeDuringNextOperation();
    await expect((await resolving.request('tools/list')).json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('The session grant is no longer active.') },
    });

    const invoking = fixture();
    invoking.invokeTool.mockImplementationOnce(async () => {
      invoking.authorization.revokeGrant(invoking.grantId);
      return { content: [{ type: 'text' as const, text: 'must not return' }] };
    });
    await expect(
      (await invoking.request('tools/call', { name: 'allowed_tool', arguments: {} })).json(),
    ).resolves.toMatchObject({
      error: { message: expect.stringContaining('The session grant is no longer active.') },
    });
  });

  it('rechecks revocation after an asynchronous skill read', async () => {
    const reading = fixture();
    reading.readSkill.mockImplementationOnce(async () => {
      reading.authorization.revokeGrant(reading.grantId);
      return '# must not return';
    });
    await expect(
      (await reading.request('resources/read', { uri: 'doompi://session/alpha/skills/allowed-skill' })).json(),
    ).resolves.toMatchObject({
      error: { message: expect.stringContaining('The session grant is no longer active.') },
    });
  });

  it('rejects access after the session generation changes or is revoked', async () => {
    const { request, setGeneration } = fixture();
    setGeneration(8);
    expect((await request('tools/list')).status).toBe(401);

    const current = fixture();
    expect(current.authorization.revokeSessionGeneration('alpha', 7)).toBe(1);
    expect((await current.request('tools/list')).status).toBe(401);
  });
  it('advertises and reads only UI resources associated with granted tools', async () => {
    const f = fixture();
    f.setUiEnabled(true);
    const listing = ListToolsResultSchema.parse(rpcResult(await (await f.request('tools/list')).json()));
    expect(listing.tools[0]?._meta).toEqual({
      ui: { resourceUri: UI_RESOURCE.uri, visibility: ['model', 'app'] },
      'openai/outputTemplate': UI_RESOURCE.uri,
    });
    const resources = rpcResult(await (await f.request('resources/list')).json());
    expect(JSON.stringify(resources)).toContain(UI_RESOURCE.uri);
    expect(JSON.stringify(resources)).not.toContain('ui://doompi/hidden');
    const result = rpcResult(await (await f.request('resources/read', { uri: UI_RESOURCE.uri })).json());
    expect(result).toEqual({ contents: [{ ...UI_RESOURCE, text: '<!doctype html><title>Session</title>' }] });
    expect(f.readUiResource).toHaveBeenCalledWith(12, UI_RESOURCE.uri);
    expect(f.readSkill).not.toHaveBeenCalled();
    expect(f.invokeTool).not.toHaveBeenCalled();
  });

  it.each([
    'ui://doompi/hidden/v1/index.html',
    'ui://doompi/test/v1/index.html?session=other',
    'ui://doompi/test/v1/../index.html',
    'ui://doompi/missing/v1/index.html',
  ])('rejects an ungranted or non-exact UI resource: %s', async (uri) => {
    const f = fixture();
    f.setUiEnabled(true);
    expect(await (await f.request('resources/read', { uri })).json()).toMatchObject({ error: { code: -32602 } });
    expect(f.readUiResource).not.toHaveBeenCalled();
  });

  it.each(['revoke', 'revision', 'removed', 'generation'] as const)(
    'rejects UI content if %s changes while its loader is running',
    async (change) => {
      const f = fixture();
      f.setUiEnabled(true);
      f.readUiResource.mockImplementationOnce(async () => {
        if (change === 'revoke') f.authorization.revokeGrant(f.grantId);
        if (change === 'revision') f.enableNewCapabilities();
        if (change === 'removed') f.setUiEnabled(false);
        if (change === 'generation') f.setGeneration(8);
        return 'must-not-leak';
      });
      const result = await (await f.request('resources/read', { uri: UI_RESOURCE.uri })).json();
      expect(result).toHaveProperty('error');
      expect(JSON.stringify(result)).not.toContain('must-not-leak');
    },
  );
});
