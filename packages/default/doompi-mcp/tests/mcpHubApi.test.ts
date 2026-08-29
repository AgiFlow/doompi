import type { DoomApiContext } from '@agimon-ai/doompi-extension-contracts/package-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsManager } from '../src/adapters/node/mcpSettingsManager.ts';
import { mcpHubApi } from '../src/adapters/web/mcpHubApi.ts';
import type { McpAuthorizationFlow, McpRepositoryCatalog } from '../src/types/webMcp.ts';

const REPOSITORY_ID = `repo-${'a'.repeat(24)}`;
const REPOSITORY_ROOT = '/admitted/repository';
const FLOW_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SYNC = { fresh: true, reasons: [] };
const CATALOG: McpRepositoryCatalog = {
  repositoryId: REPOSITORY_ID,
  sync: SYNC,
  servers: [],
  droppedServers: [],
  diagnostics: [],
};
const FLOW: McpAuthorizationFlow = {
  id: FLOW_ID,
  repositoryId: REPOSITORY_ID,
  serverName: 'github',
  status: 'waiting',
  expiresAt: Date.now() + 60_000,
};

function startApi(overrides: Partial<DoomApiContext> = {}) {
  vi.spyOn(McpSettingsManager.prototype, 'dispose').mockResolvedValue();
  return mcpHubApi.start({
    scope: 'hub',
    onNotice: () => undefined,
    resolveRepository: () => REPOSITORY_ROOT,
    readRepositorySync: () => SYNC,
    ...overrides,
  });
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://doom.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcpHubApi routes', () => {
  it('reads the admitted repository catalog', async () => {
    const readCatalog = vi.spyOn(McpSettingsManager.prototype, 'readCatalog').mockResolvedValue(CATALOG);
    const handler = startApi();

    const response = await handler.fetch(new Request(`http://doom.test/repository?repositoryId=${REPOSITORY_ID}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(CATALOG);
    expect(readCatalog).toHaveBeenCalledWith(REPOSITORY_ID, REPOSITORY_ROOT, SYNC);
    handler.close();
  });

  it('reports catalog read failures without exposing internal errors', async () => {
    vi.spyOn(McpSettingsManager.prototype, 'readCatalog').mockRejectedValue(new Error('private path'));
    const handler = startApi({ readRepositorySync: undefined });

    const response = await handler.fetch(new Request(`http://doom.test/repository?repositoryId=${REPOSITORY_ID}`));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'The synced MCP catalog could not be read.' });
    handler.close();
  });

  it.each([
    ['malformed JSON', '{'],
    ['oversized JSON', JSON.stringify({ repositoryId: REPOSITORY_ID, padding: 'x'.repeat(9_000) })],
  ])('rejects %s discovery bodies', async (_label, body) => {
    const handler = startApi();
    const response = await handler.fetch(new Request('http://doom.test/repository/discover', { method: 'POST', body }));

    expect(response.status).toBe(400);
    handler.close();
  });

  it('discovers live capabilities for an admitted repository', async () => {
    const discover = vi.spyOn(McpSettingsManager.prototype, 'discover').mockResolvedValue(CATALOG);
    const handler = startApi();

    const response = await handler.fetch(jsonRequest('/repository/discover', { repositoryId: REPOSITORY_ID }));

    expect(response.status).toBe(200);
    expect(discover).toHaveBeenCalledWith(REPOSITORY_ID, REPOSITORY_ROOT, SYNC);
    handler.close();
  });

  it.each([
    ['already active', 409],
    ['Sync this repository before discovery.', 409],
    ['server is not enabled', 404],
    ['private failure', 500],
  ])('maps discovery failure "%s" to %s', async (message, status) => {
    vi.spyOn(McpSettingsManager.prototype, 'discover').mockRejectedValue(new Error(message));
    const handler = startApi();

    const response = await handler.fetch(jsonRequest('/repository/discover', { repositoryId: REPOSITORY_ID }));

    expect(response.status).toBe(status);
    handler.close();
  });

  it.each(['', `bad\u0000name`, 'x'.repeat(161)])('rejects invalid server name %j', async (serverName) => {
    const handler = startApi();
    const response = await handler.fetch(
      jsonRequest('/repository/authorize', { repositoryId: REPOSITORY_ID, serverName }),
    );

    expect(response.status).toBe(400);
    handler.close();
  });

  it('starts authorization for a valid server', async () => {
    const authorize = vi.spyOn(McpSettingsManager.prototype, 'authorize').mockResolvedValue(FLOW);
    const handler = startApi();

    const response = await handler.fetch(
      jsonRequest('/repository/authorize', { repositoryId: REPOSITORY_ID, serverName: 'github' }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(FLOW);
    expect(authorize).toHaveBeenCalledWith(REPOSITORY_ID, REPOSITORY_ROOT, SYNC, 'github');
    handler.close();
  });

  it('reads and cancels authorization flows', async () => {
    const getAuthorization = vi.spyOn(McpSettingsManager.prototype, 'getAuthorization').mockReturnValue(FLOW);
    const cancelAuthorization = vi.spyOn(McpSettingsManager.prototype, 'cancelAuthorization').mockResolvedValue(FLOW);
    const handler = startApi();
    const path = `/repository/authorize/${FLOW_ID}?repositoryId=${REPOSITORY_ID}`;

    const read = await handler.fetch(new Request(`http://doom.test${path}`));
    const cancelled = await handler.fetch(new Request(`http://doom.test${path}`, { method: 'DELETE' }));

    expect(read.status).toBe(200);
    expect(cancelled.status).toBe(200);
    expect(getAuthorization).toHaveBeenCalledWith(FLOW_ID, REPOSITORY_ID);
    expect(cancelAuthorization).toHaveBeenCalledWith(FLOW_ID, REPOSITORY_ID);
    handler.close();
  });

  it('rejects invalid or unavailable authorization flows', async () => {
    vi.spyOn(McpSettingsManager.prototype, 'getAuthorization').mockReturnValue(undefined);
    const handler = startApi();

    const invalid = await handler.fetch(
      new Request(`http://doom.test/repository/authorize/not-a-flow?repositoryId=${REPOSITORY_ID}`),
    );
    const unavailable = await handler.fetch(
      new Request(`http://doom.test/repository/authorize/${FLOW_ID}?repositoryId=${REPOSITORY_ID}`),
    );

    expect(invalid.status).toBe(400);
    expect(unavailable.status).toBe(404);
    handler.close();
  });

  it('returns not found for routes outside the MCP API', async () => {
    const handler = startApi();

    const response = await handler.fetch(new Request('http://doom.test/unknown'));

    expect(response.status).toBe(404);
    handler.close();
  });
});
