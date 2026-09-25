import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DoomMcpProjection } from '@agimon-ai/doompi-core/mcpProjection';

import type { McpSessionConfig } from '../../types/mcpConfig';

/**
 * Converts the immutable cross-package projection into the MCP session's input.
 *
 * The projection is authoritative even when disabled or empty. In particular,
 * this adapter never fills an empty Doom projection from cwd or process env.
 */
export function mcpSessionConfigFromProjection(
  projection: DoomMcpProjection,
  cwd = projection.repoRoot,
): McpSessionConfig {
  let sources = projection.sources;
  if (projection.enabled && cwd !== projection.repoRoot) {
    const configPath = path.join(cwd, '.mcp.json');
    let repositorySource: (typeof projection.sources)[number] | undefined;
    try {
      const content = fs.readFileSync(configPath);
      repositorySource = {
        sourceId: 'repository:.mcp.json',
        owner: 'repository',
        format: 'native',
        configPath,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    sources = [
      ...projection.sources.filter((source) => source.owner !== 'repository'),
      ...(repositorySource ? [repositorySource] : []),
    ];
  }
  return {
    enabled: projection.enabled,
    repoRoot: cwd,
    stagingDirectory: projection.stagingDirectory,
    ...(cwd === projection.repoRoot && projection.generatedConfigPath
      ? { generatedConfigPath: projection.generatedConfigPath }
      : {}),
    sources,
    ...(projection.allowlist
      ? {
          allowlist: {
            ...(projection.allowlist.servers ? { servers: [...projection.allowlist.servers] } : {}),
            ...(projection.allowlist.proxy ? { proxy: [...projection.allowlist.proxy] } : {}),
          },
        }
      : {}),
  };
}
