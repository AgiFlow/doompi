import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionMcpClient,
  listSessionMcpClients,
  readSessionMcpConfig,
  revokeSessionMcpClient,
  setupSessionMcpDirectory,
  removeSessionMcpSetup,
} from '../../src/web/lib/sessionMcpApi';

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const config = {
  audience: 'https://doom.example/api/workspaces/w/mcp',
  authorizationEndpoint: 'https://doom.example/oauth/authorize',
  tokenEndpoint: 'https://doom.example/oauth/token',
  tools: [{ name: 'bash', label: 'Bash', description: 'Run a shell command.' }],
  skills: [{ name: 'review', description: 'Review changes.', uri: 'doompi://skills/review' }],
};
const client = {
  clientId: 'client-1',
  name: 'ChatGPT · doom.example',
  redirectUri: 'https://chatgpt.com/callback',
  tokenEndpointAuthMethod: 'client_secret_post' as const,
  createdAt: 1,
  scope: 'session' as const,
  tools: [],
  skills: [],
  audience: config.audience,
};

afterEach(() => vi.unstubAllGlobals());

describe('session MCP management API', () => {
  it('reads the final session surface and metadata-only client list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, config))
      .mockResolvedValueOnce(respond(200, { clients: [{ ...client, clientSecret: 'must-not-enter-state' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readSessionMcpConfig('workspace/a', 'session b')).resolves.toEqual({ config });
    await expect(listSessionMcpClients('workspace/a', 'session b')).resolves.toEqual({ clients: [client] });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspaces/workspace%2Fa/sessions/session%20b/mcp/config', {
      cache: 'no-store',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspaces/workspace%2Fa/sessions/session%20b/mcp/clients', {
      cache: 'no-store',
    });
  });

  it('creates a live session-scoped client and returns the one-time secret', async () => {
    const created = { ...client, clientSecret: 'one-time-secret' };
    const fetchMock = vi.fn().mockResolvedValue(respond(201, { client: created }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSessionMcpClient('workspace', 'session', {
        redirectUri: 'https://chatgpt.com/callback',
        scope: 'session',
      }),
    ).resolves.toEqual({ client: created });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/workspace/sessions/session/mcp/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Doompi-Mcp-Csrf': '1' },
      body: JSON.stringify({
        redirectUri: 'https://chatgpt.com/callback',
        scope: 'session',
      }),
    });
  });

  it('revokes an encoded client id and reports host errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { ok: true }))
      .mockResolvedValueOnce(respond(403, { error: 'MCP clients can only be managed on the host.' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeSessionMcpClient('workspace', 'session', 'client/1')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspaces/workspace/sessions/session/mcp/clients/client%2F1', {
      method: 'DELETE',
      headers: { 'X-Doompi-Mcp-Csrf': '1' },
    });
    await expect(listSessionMcpClients('workspace', 'session')).resolves.toEqual({
      error: 'MCP clients can only be managed on the host.',
    });
  });

  it('rejects malformed success bodies and reports an unreachable host', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { ...config, tools: [{ name: 'bash' }] })));
    await expect(readSessionMcpConfig('workspace', 'session')).resolves.toEqual({ error: 'The hub answered 200.' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(listSessionMcpClients('workspace', 'session')).resolves.toEqual({
      error: 'The cockpit hub is unreachable.',
    });
  });
  it('preserves validated routing metadata and refuses unknown routing modes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond(200, { clients: [{ ...client, routing: 'conversation' }] })),
    );
    await expect(listSessionMcpClients('w', 's')).resolves.toEqual({
      clients: [{ ...client, routing: 'conversation' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond(200, { clients: [{ ...client, routing: 'last-active' }] })),
    );
    await expect(listSessionMcpClients('w', 's')).resolves.toEqual({ error: 'The hub answered 200.' });
  });

  it('sends an explicit routing choice and verification acknowledgment without altering direct clients', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(respond(201, { client: { ...client, routing: 'conversation', clientSecret: 'secret' } }));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      redirectUri: client.redirectUri,
      scope: 'session' as const,
      routing: 'conversation' as const,
      conversationIdentityVerified: true,
    };
    await createSessionMcpClient('w', 's', input);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/w/sessions/s/mcp/clients',
      expect.objectContaining({ body: JSON.stringify(input) }),
    );
  });

  it('fails closed when an older host silently creates a direct client instead of conversation routing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond(201, { client: { ...client, clientSecret: 'not-returned' } })),
    );
    const result = await createSessionMcpClient('w', 's', {
      redirectUri: client.redirectUri,
      scope: 'session',
      routing: 'conversation',
      conversationIdentityVerified: true,
    });
    expect(result).toEqual({ error: expect.stringContaining('did not enable the requested routing mode') });
    expect(result).not.toHaveProperty('client');
  });

  it('targets the parent and reservation explicitly and validates the returned target identity', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(200, { session: { sessionId: 'child' } }))
      .mockResolvedValueOnce(respond(200, { session: { sessionId: 'other' } }))
      .mockResolvedValueOnce(respond(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(setupSessionMcpDirectory('w/a', 'parent b', 'child', '/checkout')).resolves.toEqual({
      sessionId: 'child',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspaces/w%2Fa/sessions/parent%20b/mcp/conversations/child', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Doompi-Mcp-Csrf': '1' },
      body: JSON.stringify({ cwd: '/checkout' }),
    });
    await expect(setupSessionMcpDirectory('w', 'parent', 'child', '/checkout')).resolves.toEqual({
      error: 'The hub answered 200.',
    });
    await expect(removeSessionMcpSetup('w', 'parent', 'child')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/workspaces/w/sessions/parent/mcp/conversations/child',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
