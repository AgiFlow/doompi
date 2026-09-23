import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import type { Context } from '@deepseek-ai/cordis';

import { COMPUTER_USE_MODE_ID } from '../../types/computerUseApi';

export const COMPUTER_USE_MCP_TOOLS_SERVICE = 'doom/computer-use-mcp-tools';

const MODE_LABEL = 'Computer Use';

export interface McpToolCatalog {
  get(name: string): DoomHeadlessTool | undefined;
  names(): readonly string[];
}

export function mountMcpTools(tools: readonly DoomHeadlessTool[]) {
  return (context: Context): void => {
    context.plugin((providerContext) => {
      providerContext.provide(COMPUTER_USE_MCP_TOOLS_SERVICE, {
        get: (name) => tools.find((tool) => tool.name === name),
        names: () => tools.map((tool) => tool.name),
      } satisfies McpToolCatalog);
    });
  };
}

export function bindMcpTool(context: DoomMcpPluginContext, name: string): DoomHeadlessTool {
  const catalog = context.services.get<McpToolCatalog>(COMPUTER_USE_MCP_TOOLS_SERVICE);
  const tool = catalog?.get(name);
  if (!tool || !catalog) throw new Error(`Computer use tool is unavailable: ${name}`);
  return {
    ...tool,
    execute(toolCallId, parameters, signal, onUpdate) {
      const activeModes = context.selection.read().state?.['minor-mode'] ?? [];
      if (!activeModes.includes(COMPUTER_USE_MODE_ID)) {
        const inactiveTools = [...catalog.names()].sort().join(', ');
        throw new Error(`${MODE_LABEL} minor mode is inactive. Inactive ${MODE_LABEL} tools: ${inactiveTools}.`);
      }
      const executionSignal = AbortSignal.any([context.signal, signal ?? context.signal]);
      return tool.execute(toolCallId, parameters, executionSignal, onUpdate, context.execution);
    },
  };
}
