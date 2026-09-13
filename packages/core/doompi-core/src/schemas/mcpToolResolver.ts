import type { Context } from '@deepseek-ai/cordis';

/** Session-scoped resolver for MCP selectors confirmed by the loaded MCP provider. */
export const DOOM_MCP_TOOL_RESOLVER_SERVICE = 'doom/mcp-tool-resolver';

export interface DoomMcpResolvedToolSelection {
  /** Exact tool name registered with Pi. */
  readonly name: string;
  /** Canonical `server/tool` selector represented by this result. */
  readonly selector: string;
}

export interface DoomMcpToolResolverService {
  /** Fences consumers against a replaced MCP session. */
  readonly generation: string;
  resolve(selectors: readonly string[]): readonly DoomMcpResolvedToolSelection[];
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/mcp-tool-resolver': DoomMcpToolResolverService;
  }
}

export function readDoomMcpToolResolver(context: Context): DoomMcpToolResolverService | undefined {
  return context.get(DOOM_MCP_TOOL_RESOLVER_SERVICE) as DoomMcpToolResolverService | undefined;
}

export function requireDoomMcpToolResolver(context: Context): DoomMcpToolResolverService {
  const service = readDoomMcpToolResolver(context);
  if (!service) throw new Error('Doom MCP tool resolver is unavailable. Load @agimon-ai/doompi-mcp.');
  return service;
}
