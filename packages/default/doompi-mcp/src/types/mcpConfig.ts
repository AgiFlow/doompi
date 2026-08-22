import type { DoomMcpProjectionSource } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import type { DoomMcpSessionAllowlist, DoomMcpSessionConfig } from '@agimon-ai/doompi-extension-contracts/mcp-session';
import type { ConfigMergeStrategy, ConfigSourceFormat } from '@agimon-ai/mcp-proxy';

/** Domain policy. An absent or empty list means "keep everything". */
export type McpAllowlist = DoomMcpSessionAllowlist;

export interface McpConfigGroupsInput {
  /** Explicit false is the fail-closed Doom projection. */
  enabled?: boolean;
  repoRoot: string;
  /** Merged config emitted for external clients; retained in the complete session projection. */
  generatedConfigPath?: string;
  /** Absolute paths to the `.mcp.json` of each plugin selected for this session. */
  pluginConfigPaths?: string[];
  /** Authoritative, content-addressed layers supplied by the Doom session projection. */
  sources?: readonly DoomMcpProjectionSource[];
  allowlist?: McpAllowlist;
  /** Where filtered copies land. Written whenever policy or wrapper removal changes a layer. */
  stagingDirectory: string;
}

/** A typed mcp-proxy layer. Doom always supplies the format explicitly. */
export interface McpConfigSource {
  path: string;
  format: ConfigSourceFormat;
  optional?: boolean;
  mergeStrategy?: ConfigMergeStrategy;
  /** Stable semantic identity used for the definitions cache; never derived from a per-run staging path. */
  cacheKey: string;
}

/** Worktree-level upstreams that Doom connects directly in process. */
export interface SharedConfigGroup {
  configSources: McpConfigSource[];
  /** @deprecated Use `configSources`; retained for callers inspecting paths. */
  configPaths: string[];
  /** Enabled servers declared by these layers, after filtering. */
  serverNames: string[];
}

/** Plugin and repository servers that Doom connects directly in process. */
export interface SessionConfigGroup {
  configSources: McpConfigSource[];
  /** @deprecated Use `configSources`; retained for callers inspecting paths. */
  configPaths: string[];
  /** Enabled servers declared by these layers, after filtering. */
  serverNames: string[];
}

export interface McpConfigGroups {
  shared: SharedConfigGroup;
  sessionLocal: SessionConfigGroup;
  /** Servers removed before the embedded MCP client saw them, for diagnostics. */
  droppedServers: string[];
  /** Invalid portable sources and isolated invalid server entries. */
  diagnostics: string[];
}

export type McpSessionConfig = DoomMcpSessionConfig;
