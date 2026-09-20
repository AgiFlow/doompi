import type { DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';

import type { CatalogTool } from '../mcpCatalog';
import type { McpSession } from '../mcpSession';

export const MCP_SESSION_TOOLS_SERVICE = 'doom/mcp-session-tools';

/** Narrow cross-root access to the Pi session's existing upstream MCP runtime. */
export interface McpSessionToolsService {
  readonly generation: string;
  snapshot(): readonly CatalogTool[];
  onChange(listener: () => void): () => void;
  invoke(name: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<DoomHeadlessToolResult>;
}

export function createMcpSessionToolsService(session: McpSession, generation: string): McpSessionToolsService {
  return Object.freeze({
    generation,
    snapshot: () => session.activeToolDefinitions(),
    onChange: (listener: () => void) => session.onChange(listener),
    invoke: (name: string, parameters: Record<string, unknown>, signal?: AbortSignal) =>
      session.invokeTool(name, parameters, signal),
  });
}
