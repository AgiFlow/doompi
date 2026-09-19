import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import type { Context } from '@deepseek-ai/cordis';

export const COMPUTER_USE_MCP_TOOLS_SERVICE = 'doom/computer-use-mcp-tools';

export interface McpToolCatalog {
  get(name: string): DoomHeadlessTool | undefined;
}

export function mountMcpTools(tools: readonly DoomHeadlessTool[]) {
  return (context: Context): void => {
    context.plugin((providerContext) => {
      providerContext.provide(COMPUTER_USE_MCP_TOOLS_SERVICE, {
        get: (name) => tools.find((tool) => tool.name === name),
      } satisfies McpToolCatalog);
    });
  };
}

export function bindMcpTool(context: DoomMcpPluginContext, name: string): DoomHeadlessTool {
  const tool = context.services.get<McpToolCatalog>(COMPUTER_USE_MCP_TOOLS_SERVICE)?.get(name);
  if (!tool) throw new Error(`Computer use tool is unavailable: ${name}`);
  return {
    ...tool,
    execute(toolCallId, parameters, signal, onUpdate) {
      const executionSignal = AbortSignal.any([context.signal, signal ?? context.signal]);
      return tool.execute(toolCallId, parameters, executionSignal, onUpdate, context.execution);
    },
  };
}
