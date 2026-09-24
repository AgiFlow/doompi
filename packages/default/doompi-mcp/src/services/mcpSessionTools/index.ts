import type { DoomChildSessionTool } from '@agimon-ai/doompi-core/childSession';
import type { DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { McpHeadlessToolParameters } from '../../schemas/mcpHeadlessTool';
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

/** Borrow an existing MCP runtime; a child never starts or disposes its own upstream connections. */
export function createMcpChildTool(
  invoke: (
    parameters: Static<typeof McpHeadlessToolParameters>,
    signal?: AbortSignal,
  ) => Promise<DoomHeadlessToolResult>,
): DoomChildSessionTool {
  return {
    name: 'mcp',
    description: 'Call a tool exposed by a connected MCP server.',
    parameters: McpHeadlessToolParameters,
    async execute(_toolCallId, parameters, signal) {
      signal?.throwIfAborted();
      if (!Value.Check(McpHeadlessToolParameters, parameters)) throw new Error('Invalid MCP tool arguments.');
      const result = await invoke(parameters, signal);
      signal?.throwIfAborted();
      return result;
    },
  };
}
