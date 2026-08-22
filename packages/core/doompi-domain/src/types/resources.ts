import type { PluginHookSource } from '@agimon-ai/doompi-config/types';
import type { DoomMcpProjection, DoomMcpProjectionSource } from '@agimon-ai/doompi-extension-contracts/mcp-projection';

/** A JSON document the harness owns on disk, before it is given a shape. */
export type JsonObject = Record<string, unknown>;

/** A skill or agent that has been located and named, but not yet staged. */
export interface NamedResource {
  name: string;
  path: string;
  digest?: string;
}

export interface HarnessResourceOptions {
  agents: boolean;
  mcp: boolean;
  temporaryDirectory?: string;
  /** Persistent metadata cache; defaults to the home-scoped worktree cache. */
  skillCacheDirectory?: string;
  /** Domain MCP allowlist. Omit to keep every configured server. */
  mcpAllowlist?: { servers?: string[]; proxy?: string[] };
  /** Include .claude/skills as fallbacks after selected plugin skills. Defaults to true. */
  sharedSkills?: boolean;
  /** Persistent root for Agent Plugin data; defaults to the user's Doom config directory. */
  pluginDataRoot?: string;
}

export interface McpResourceOptions {
  enabled: boolean;
  temporaryDirectory: string;
  /** Domain MCP allowlist. Omit to keep every configured server. */
  mcpAllowlist?: { servers?: string[]; proxy?: string[] };
  /** Persistent root for Agent Plugin data; defaults to the user's Doom config directory. */
  pluginDataRoot?: string;
}

export interface StagedMcpResources {
  mcpConfigPath?: string;
  mcpProjection: DoomMcpProjection;
  pluginMcpSources: DoomMcpProjectionSource[];
  pluginMcpConfigPaths: string[];
}

export interface HarnessResources {
  temporaryDirectory: string;
  /** Exact SKILL.md paths compiled from the selected discovery roots. */
  skillDirectories: string[];
  /** Number of discovered SKILL.md files, which is what reaches the model. */
  skillCount: number;
  agentCount: number;
  agentDirectories: string[];
  pluginHooks: PluginHookSource[];
  mcpConfigPath?: string;
  /** Immutable source snapshot published through the replacement session's Cordis registry. */
  mcpProjection: DoomMcpProjection;
  /** Ordered plugin descriptors retained for focused resource diagnostics. */
  pluginMcpSources: DoomMcpProjectionSource[];
  /** Legacy path-only view of the selected plugin MCP sources, in precedence order. */
  pluginMcpConfigPaths: string[];
  cleanup(): Promise<void>;
}
