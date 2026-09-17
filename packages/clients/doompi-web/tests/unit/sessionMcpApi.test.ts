import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionMcpClient,
  listSessionMcpClients,
  readSessionMcpConfig,
  revokeSessionMcpClient,
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
  name: 'ChatGPT',
  redirectUri: 'https://chatgpt.com/callback',
  tokenEndpointAuthMethod: 'client_secret_post' as const,
  createdAt: 1,
  tools: ['bash'],
  skills: ['review'],
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

  it('creates an immutable explicit grant and returns the one-time secret', async () => {
    const created = { ...client, clientSecret: 'one-time-secret' };
    const fetchMock = vi.fn().mockResolvedValue(respond(201, { client: created }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSessionMcpClient('workspace', 'session', {
        name: 'ChatGPT',
        redirectUri: 'https://chatgpt.com/callback',
        tools: ['bash'],
        skills: ['review'],
      }),
    ).resolves.toEqual({ client: created });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/workspace/sessions/session/mcp/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Doompi-Mcp-Csrf': '1' },
      body: JSON.stringify({
        name: 'ChatGPT',
        redirectUri: 'https://chatgpt.com/callback',
        tools: ['bash'],
        skills: ['review'],
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
});
