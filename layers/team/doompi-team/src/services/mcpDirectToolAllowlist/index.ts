import type {
  DoomMcpResolvedToolSelection,
  DoomMcpToolResolverService,
} from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';

export type ResolvedMcpDirectToolSelection = DoomMcpResolvedToolSelection;
export type McpDirectToolResolver = Pick<DoomMcpToolResolverService, 'resolve'>;

/**
 * Session-owned bridge between Team's launch planner and an optional MCP provider.
 *
 * The stable bridge can be threaded through Team's ordinary object graph while
 * Cordis replaces the live provider binding. Provider removal always narrows to
 * no direct MCP tools, and a stale provider disposer cannot clear its replacement.
 */
export class McpDirectToolResolverBinding implements McpDirectToolResolver {
  private active: DoomMcpToolResolverService | undefined;

  bind(service: DoomMcpToolResolverService): () => void {
    this.active = service;
    let bound = true;
    return () => {
      if (!bound) return;
      bound = false;
      if (this.active === service) this.active = undefined;
    };
  }

  resolve(selectors: readonly string[]): readonly DoomMcpResolvedToolSelection[] {
    if (selectors.length === 0) return [];
    try {
      return this.active?.resolve(selectors) ?? [];
    } catch {
      // A provider failure cannot widen a child's tool grant. Resolving nothing
      // is the narrow result and is surfaced later by the child tool diagnostic.
      return [];
    }
  }
}

export function resolveMcpDirectToolSelections(
  mcpDirectTools: readonly string[] | undefined,
  resolver?: McpDirectToolResolver,
): ResolvedMcpDirectToolSelection[] {
  if (!mcpDirectTools?.length || !resolver) return [];
  try {
    return [...resolver.resolve(mcpDirectTools)];
  } catch {
    return [];
  }
}

export function resolveMcpDirectToolNames(
  mcpDirectTools: readonly string[] | undefined,
  resolver?: McpDirectToolResolver,
): string[] {
  return resolveMcpDirectToolSelections(mcpDirectTools, resolver).map((selection) => selection.name);
}
