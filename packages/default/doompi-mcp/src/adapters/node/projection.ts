import type { DoomMcpProjection } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import type { McpSessionConfig } from '../../types/mcpConfig.ts';

/**
 * Converts the immutable cross-package projection into the MCP session's input.
 *
 * The projection is authoritative even when disabled or empty. In particular,
 * this adapter never fills an empty Doom projection from cwd or process env.
 */
export function mcpSessionConfigFromProjection(projection: DoomMcpProjection): McpSessionConfig {
  return {
    enabled: projection.enabled,
    repoRoot: projection.repoRoot,
    stagingDirectory: projection.stagingDirectory,
    ...(projection.generatedConfigPath ? { generatedConfigPath: projection.generatedConfigPath } : {}),
    sources: projection.sources,
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
