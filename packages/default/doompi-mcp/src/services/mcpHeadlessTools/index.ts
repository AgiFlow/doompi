import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import type { Context } from '@deepseek-ai/cordis';

export const MCP_HEADLESS_TOOLS_SERVICE = 'doom/mcp-headless-tools';

export interface McpHeadlessToolCatalog {
  get(name: string): DoomHeadlessTool | undefined;
}

export function mountMcpHeadlessTools(tools: readonly DoomHeadlessTool[]) {
  return (context: Context): void => {
    context.plugin((providerContext) => {
      providerContext.provide(MCP_HEADLESS_TOOLS_SERVICE, {
        get: (name) => tools.find((tool) => tool.name === name),
      } satisfies McpHeadlessToolCatalog);
    });
  };
}

export function bindMcpHeadlessTool(context: DoomMcpPluginContext, name: string): DoomHeadlessTool {
  const tool = context.services.get<McpHeadlessToolCatalog>(MCP_HEADLESS_TOOLS_SERVICE)?.get(name);
  if (!tool) throw new Error(`MCP tool is unavailable: ${name}`);
  return {
    ...tool,
    execute(toolCallId, parameters, signal, onUpdate) {
      const executionSignal = AbortSignal.any([context.signal, signal ?? context.signal]);
      return tool.execute(toolCallId, parameters, executionSignal, onUpdate, context.execution);
    },
  };
}
