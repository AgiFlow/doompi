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
  const client = authorization.createClient({ name: 'MCP client', redirectUri: 'https://client.example/callback' });
  const binding = {
    clientId: client.clientId,
    sessionId: 'alpha',
    sessionGeneration: 7,
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
  const invokeTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'called' }] }));
  const readSkill = vi.fn(() => '# Allowed skill');
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
      if (resolveCount === revokeAtResolve) authorization.revokeGrant(code.grant.id);
      return { generation, toolSurface };
    },
  });
  const request = (method: string, params?: Record<string, unknown>, token = tokens.accessToken) =>
    handler(
      new Request(AUDIENCE, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
      }),
    );
  return {
    authorization,
    handler,
    request,
    invokeTool,
    readSkill,
    grantId: code.grant.id,
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
    });

    const hidden = await request('tools/call', { name: 'hidden_tool', arguments: {} });
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: -32602 } });
    expect(invokeTool).toHaveBeenCalledTimes(1);
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

  it('rejects access after the session generation changes or is revoked', async () => {
    const { request, setGeneration } = fixture();
    setGeneration(8);
    expect((await request('tools/list')).status).toBe(401);

    const current = fixture();
    expect(current.authorization.revokeSessionGeneration('alpha', 7)).toBe(1);
    expect((await current.request('tools/list')).status).toBe(401);
  });
});
