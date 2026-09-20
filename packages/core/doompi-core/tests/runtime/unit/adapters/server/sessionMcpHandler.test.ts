import { createHash } from 'node:crypto';

import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { createSessionMcpHttpHandler } from '../../../../../src/server/sessionMcpHandler';
import { createSessionMcpAuthorizationService } from '../../../../../src/services/sessionMcpAuthorization';
import type { SessionToolSurface } from '../../../../../src/types/server/sessionToolSurface';

const AUDIENCE = 'https://host.example/sessions/alpha/mcp';
const VERIFIER = 'v'.repeat(43);

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
  const invokeTool = vi.fn(async (_invocation: Parameters<SessionToolSurface['invokeTool']>[0]) => ({
    content: [{ type: 'text' as const, text: 'called' }],
  }));
  const readSkill = vi.fn(async () => '# Allowed skill');
  let revision = 12;
  let includeNewCapabilities = false;
  const toolSurface: SessionToolSurface = {
    readSurface: () => ({
      revision,
      tools: [
        { name: 'allowed_tool', label: 'Allowed tool', description: 'May run', parameters: Type.Object({}) },
        { name: 'hidden_tool', label: 'Hidden tool', description: 'Must not leak', parameters: Type.Object({}) },
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
    }),
    invokeTool,
    readSkill,
  };
  let generation = 7;
  let resolveCount = 0;
  let revokeAtResolve = -1;
  const handler = createSessionMcpHttpHandler({
    audience: AUDIENCE,
    authorization,
    resolveSession: async () => {
      resolveCount += 1;
      if (resolveCount === revokeAtResolve) authorization.revokeGrant(tokens.grantId);
      return { generation, toolSurface };
    },
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
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
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
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }),
        }),
      ),
    handler,
    request,
    invokeTool,
    readSkill,
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
    await expect(resources.json()).resolves.toMatchObject({
      result: { resources: [{ name: 'allowed-skill' }, { name: 'hidden-skill' }, { name: 'new-skill' }] },
    });
  });
  it('lists and reads only granted active skill resources', async () => {
    const { request, readSkill } = fixture();

    const listed = await request('resources/list');
    await expect(listed.json()).resolves.toMatchObject({
      result: { resources: [{ name: 'allowed-skill', uri: 'doompi://session/alpha/skills/allowed-skill' }] },
    });

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
});
