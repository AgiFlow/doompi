import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TokenStore } from '@agimon-ai/mcp-proxy';
import { afterEach, describe, expect, it } from 'vitest';
import { McpSettingsManager } from '../src/adapters/node/mcpSettingsManager.ts';
import { mcpHubApi } from '../src/adapters/web/mcpHubApi.ts';

const temporaryDirectories: string[] = [];
const REPOSITORY_ID = `repo-${'a'.repeat(24)}`;

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const tokenStore: TokenStore = {
  async read() {
    return undefined;
  },
  async write() {},
  async clear() {},
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('McpSettingsManager', () => {
  it('reads an unsynced repository without starting a runtime or exposing its path', async () => {
    const repositoryRoot = temporaryDirectory('doompi-mcp-repository-');
    const manager = new McpSettingsManager({ tokenStore });

    const catalog = await manager.readCatalog(REPOSITORY_ID, repositoryRoot, undefined);

    expect(catalog).toEqual({
      repositoryId: REPOSITORY_ID,
      sync: { fresh: false, reasons: ['never-synced'] },
      servers: [],
      droppedServers: [],
      diagnostics: [],
    });
    expect(JSON.stringify(catalog)).not.toContain(repositoryRoot);
    await manager.dispose();
  });

  it('refuses executable discovery until the repository has a fresh sync projection', async () => {
    const manager = new McpSettingsManager({ tokenStore });

    await expect(
      manager.discover(REPOSITORY_ID, temporaryDirectory('doompi-mcp-repository-'), {
        fresh: false,
        reasons: ['never-synced'],
      }),
    ).rejects.toThrow('Sync this repository before discovering MCP capabilities.');
    await manager.dispose();
  });
});

describe('mcpHubApi', () => {
  it('accepts host-issued repository ids and rejects repositories the hub has not admitted', async () => {
    const handler = mcpHubApi.start({
      scope: 'hub',
      resolveRepository: () => undefined,
      onNotice: () => undefined,
    });

    const response = await handler.fetch(
      new Request(`http://doom.test/repository?repositoryId=${encodeURIComponent(REPOSITORY_ID)}`),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'That repository is not available to this hub.' });
    handler.close();
  });

  it('rejects malformed repository ids before resolution', async () => {
    let resolved = false;
    const handler = mcpHubApi.start({
      scope: 'hub',
      resolveRepository: () => {
        resolved = true;
        return '/private/path';
      },
      onNotice: () => undefined,
    });

    const response = await handler.fetch(new Request('http://doom.test/repository?repositoryId=/private/path'));

    expect(response.status).toBe(400);
    expect(resolved).toBe(false);
    handler.close();
  });
});
