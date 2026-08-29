import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoomRepositorySyncView } from '@agimon-ai/doompi-extension-contracts/package-api';
import type { TokenStore } from '@agimon-ai/mcp-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsManager } from '../src/adapters/node/mcpSettingsManager.ts';
import { McpRuntimeOwner } from '../src/adapters/node/mcpRuntime.ts';

const REPOSITORY_ID = `repo-${'b'.repeat(24)}`;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-mcp-projection-'));
  temporaryDirectories.push(directory);
  return directory;
}

function projectedSync(repositoryRoot: string, servers: Record<string, unknown> = {}): DoomRepositorySyncView {
  const configPath = path.join(repositoryRoot, 'mcp-servers.json');
  const content = JSON.stringify({ mcpServers: servers });
  fs.writeFileSync(configPath, content);
  const contentDigest = createHash('sha256').update(content).digest('hex');
  return {
    fresh: true,
    reasons: [],
    mcpProjection: {
      version: 1,
      enabled: true,
      fingerprint: 'projection-fingerprint',
      repoRoot: repositoryRoot,
      stagingDirectory: path.join(repositoryRoot, '.staging'),
      sources: [
        {
          sourceId: 'repository-mcp',
          owner: 'repository',
          format: 'native',
          configPath,
          contentDigest,
        },
      ],
    },
  };
}

const tokenStore: TokenStore = {
  async read(serverName) {
    if (serverName === 'broken') throw new Error('keyring unavailable');
    return serverName === 'github'
      ? { serverUrl: 'https://github.example.test/mcp', tokens: { access_token: 'secret', token_type: 'Bearer' } }
      : undefined;
  },
  async write() {},
  async clear() {},
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('McpSettingsManager projections', () => {
  it('builds a path-free catalog from the host-provided projection', async () => {
    const repositoryRoot = temporaryDirectory();
    const manager = new McpSettingsManager({ tokenStore });
    const sync = projectedSync(repositoryRoot, {
      github: { type: 'stdio', command: 'github-mcp' },
      broken: { type: 'stdio', command: 'broken-mcp' },
    });

    const catalog = await manager.readCatalog(REPOSITORY_ID, repositoryRoot, sync);

    expect(catalog.sync).toEqual({ fresh: true, reasons: [] });
    expect(catalog.servers).toEqual([
      expect.objectContaining({ name: 'broken', source: 'configured', credentialPresent: false }),
      expect.objectContaining({ name: 'github', source: 'configured', credentialPresent: true }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain(repositoryRoot);
    await manager.dispose();
  });

  it('returns immediately when a fresh projection contains no sources', async () => {
    const repositoryRoot = temporaryDirectory();
    const manager = new McpSettingsManager({ tokenStore });
    const sync = projectedSync(repositoryRoot);
    sync.mcpProjection = { ...sync.mcpProjection!, sources: [] };

    const catalog = await manager.discover(REPOSITORY_ID, repositoryRoot, sync);

    expect(catalog.servers).toEqual([]);
    expect(catalog.sync.fresh).toBe(true);
    await manager.dispose();
  });

  it('rejects authorization for stale or unconfigured repositories', async () => {
    const repositoryRoot = temporaryDirectory();
    const manager = new McpSettingsManager({ tokenStore });

    await expect(manager.authorize(REPOSITORY_ID, repositoryRoot, undefined, 'github')).rejects.toThrow(
      'Sync this repository before authorizing an MCP server.',
    );
    await expect(
      manager.authorize(REPOSITORY_ID, repositoryRoot, projectedSync(repositoryRoot), 'missing'),
    ).rejects.toThrow('That MCP server is not enabled for this repository.');
    await manager.dispose();
  });

  it('retains a completed authorization flow for polling', async () => {
    vi.spyOn(McpRuntimeOwner.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(McpRuntimeOwner.prototype, 'dispose').mockResolvedValue();
    const repositoryRoot = temporaryDirectory();
    const manager = new McpSettingsManager({ tokenStore });
    const sync = projectedSync(repositoryRoot, { github: { type: 'stdio', command: 'github-mcp' } });

    const started = await manager.authorize(REPOSITORY_ID, repositoryRoot, sync, 'github');

    await vi.waitFor(() => {
      expect(manager.getAuthorization(started.id, REPOSITORY_ID)?.status).toBe('completed');
    });
    expect(manager.getAuthorization(started.id, 'another-repository')).toBeUndefined();
    expect(await manager.cancelAuthorization('missing-flow', REPOSITORY_ID)).toBeUndefined();
    await expect(manager.cancelAuthorization(started.id, REPOSITORY_ID)).resolves.toEqual(
      expect.objectContaining({ status: 'completed' }),
    );
    await manager.dispose();
  });
});
