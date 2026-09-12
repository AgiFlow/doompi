import {
  type DoomMcpSessionAllowlist,
  type DoomMcpSessionConfig,
  doomMcpSessionEnvironment,
} from '@agimon-ai/doompi-extension-contracts/mcp-session';

export interface McpSessionEnvironmentInput {
  readonly repoRoot: string;
  readonly stagingDirectory: string;
  readonly generatedConfigPath?: string;
  readonly pluginConfigPaths?: readonly string[];
  readonly allowlist?: DoomMcpSessionAllowlist;
}

/** Projects the complete domain-selected MCP picture into the Pi session environment. */
export function mcpSessionEnvironment(input: McpSessionEnvironmentInput): Record<string, string> {
  const configuration: DoomMcpSessionConfig = {
    repoRoot: input.repoRoot,
    stagingDirectory: input.stagingDirectory,
    ...(input.generatedConfigPath ? { generatedConfigPath: input.generatedConfigPath } : {}),
    ...(input.pluginConfigPaths?.length ? { pluginConfigPaths: [...input.pluginConfigPaths] } : {}),
    ...(input.allowlist ? { allowlist: structuredClone(input.allowlist) } : {}),
  };
  return doomMcpSessionEnvironment(configuration);
}
