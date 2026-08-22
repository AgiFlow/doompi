import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_PLUGIN_MCP_SCHEMA_URL,
  type DoomMcpProjection,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpConfigGroups } from '../src/adapters/node/configSources.ts';
import { mcpSessionConfigFromProjection } from '../src/adapters/node/projection.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-projection-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('mcpSessionConfigFromProjection', () => {
  it('preserves the projection as the authoritative session input', () => {
    const projection: DoomMcpProjection = {
      version: 1,
      enabled: true,
      fingerprint: 'projection-1',
      repoRoot: '/repo',
      stagingDirectory: '/run/mcp',
      generatedConfigPath: '/run/mcp.json',
      sources: [
        {
          sourceId: 'repository:mcp',
          owner: 'repository',
          format: 'native',
          configPath: '/repo/.mcp.json',
          contentDigest: 'digest',
        },
      ],
      allowlist: { servers: ['pencil'], proxy: ['logs'] },
    };

    expect(mcpSessionConfigFromProjection(projection)).toEqual({
      enabled: true,
      repoRoot: '/repo',
      stagingDirectory: '/run/mcp',
      generatedConfigPath: '/run/mcp.json',
      sources: projection.sources,
      allowlist: { servers: ['pencil'], proxy: ['logs'] },
    });
  });

  it('does not fall back to a repository config for an explicit disabled projection', () => {
    const repoRoot = temporaryDirectory();
    fs.writeFileSync(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { ambient: { type: 'stdio', command: 'ambient-server' } } }),
    );
    const configuration = mcpSessionConfigFromProjection({
      version: 1,
      enabled: false,
      fingerprint: 'disabled',
      repoRoot,
      stagingDirectory: path.join(repoRoot, '.staging'),
      sources: [],
    });

    const groups = buildMcpConfigGroups(configuration);

    expect(groups.sessionLocal.configSources).toEqual([]);
    expect(groups.shared.configSources).toEqual([]);
    expect(groups.sessionLocal.serverNames).toEqual([]);
  });

  it('turns projected Agent Plugin sources into explicitly internal runtime layers', () => {
    const repoRoot = temporaryDirectory();
    const pluginRoot = path.join(repoRoot, 'plugin');
    const pluginDataDirectory = path.join(repoRoot, 'plugin-data');
    const stagingDirectory = path.join(repoRoot, '.staging');
    fs.mkdirSync(pluginRoot);
    const contents = JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_URL,
      mcpServers: { portable: { type: 'stdio', command: 'node' } },
    });
    const configPath = path.join(pluginRoot, 'mcp.json');
    fs.writeFileSync(configPath, contents);
    const configuration = mcpSessionConfigFromProjection({
      version: 1,
      enabled: true,
      fingerprint: 'agent-plugin',
      repoRoot,
      stagingDirectory,
      sources: [
        {
          sourceId: 'plugin:portable',
          owner: 'plugin',
          format: 'agent-plugin-v1',
          pluginId: 'portable',
          pluginRoot,
          pluginDataDirectory,
          configPath,
          contentDigest: createHash('sha256').update(contents).digest('hex'),
          mcpSchemaUrl: AGENT_PLUGIN_MCP_SCHEMA_URL,
        },
      ],
    });

    const groups = buildMcpConfigGroups(configuration);

    expect(groups.sessionLocal.serverNames).toEqual(['portable']);
    expect(groups.sessionLocal.configSources).toEqual([
      {
        path: expect.stringContaining('agent-plugin-mcp-'),
        format: 'internal',
        cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
  });
});
