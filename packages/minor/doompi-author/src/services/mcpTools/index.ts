import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import type { DoomPluginTool } from '@agimon-ai/doompi-core/pi-extension';
import type { Context } from '@deepseek-ai/cordis';

export const AUTHOR_MCP_TOOLS_SERVICE = 'doom/author-mcp-tools';

export interface McpToolCatalog {
  get(name: string): DoomHeadlessTool | undefined;
}

function toHeadlessTool(tool: DoomPluginTool): DoomHeadlessTool {
  return {
    ...tool,
    async execute(toolCallId, input, signal, update, execution) {
      return tool.execute(input, {
        toolCallId,
        signal: signal ?? new AbortController().signal,
        cwd: execution.cwd,
        update: (result) => update?.(result),
        notify: (request) => execution.client.notify(request),
      });
    },
  };
}

export function mountMcpTools(tools: readonly DoomPluginTool[]) {
  const mounted = tools.map(toHeadlessTool);
  return (context: Context): void => {
    context.plugin((providerContext) => {
      providerContext.provide(AUTHOR_MCP_TOOLS_SERVICE, {
        get: (name) => mounted.find((tool) => tool.name === name),
      } satisfies McpToolCatalog);
    });
  };
}

export function bindMcpTool(context: DoomMcpPluginContext, name: string): DoomHeadlessTool {
  const tool = context.services.get<McpToolCatalog>(AUTHOR_MCP_TOOLS_SERVICE)?.get(name);
  if (!tool) throw new Error(`Author tool is unavailable: ${name}`);
  return {
    ...tool,
    execute(toolCallId, parameters, signal, onUpdate) {
      const executionSignal = AbortSignal.any([context.signal, signal ?? context.signal]);
      return tool.execute(toolCallId, parameters, executionSignal, onUpdate, context.execution);
    },
  };
}
