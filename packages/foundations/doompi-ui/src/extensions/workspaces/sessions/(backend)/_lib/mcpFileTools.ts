import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { createFindTool, createLsTool, createWriteTool } from '@earendil-works/pi-coding-agent';

export function createMcpWriteTool(
  context: DoomMcpPluginContext,
): DoomHeadlessTool<ReturnType<typeof createWriteTool>['parameters']> {
  const tool = createWriteTool(context.execution.cwd);
  return {
    ...tool,
    executionMode: tool.executionMode === 'sequential' ? 'serial' : tool.executionMode,
    execute(toolCallId, parameters, signal, onUpdate) {
      return tool.execute(
        toolCallId,
        parameters,
        AbortSignal.any([context.signal, signal ?? context.signal]),
        onUpdate,
      );
    },
  };
}

export function createMcpFindTool(
  context: DoomMcpPluginContext,
): DoomHeadlessTool<ReturnType<typeof createFindTool>['parameters']> {
  const tool = createFindTool(context.execution.cwd);
  return {
    ...tool,
    executionMode: tool.executionMode === 'sequential' ? 'serial' : tool.executionMode,
    execute(toolCallId, parameters, signal, onUpdate) {
      return tool.execute(
        toolCallId,
        parameters,
        AbortSignal.any([context.signal, signal ?? context.signal]),
        onUpdate,
      );
    },
  };
}

export function createMcpLsTool(
  context: DoomMcpPluginContext,
): DoomHeadlessTool<ReturnType<typeof createLsTool>['parameters']> {
  const tool = createLsTool(context.execution.cwd);
  return {
    ...tool,
    executionMode: tool.executionMode === 'sequential' ? 'serial' : tool.executionMode,
    execute(toolCallId, parameters, signal, onUpdate) {
      return tool.execute(
        toolCallId,
        parameters,
        AbortSignal.any([context.signal, signal ?? context.signal]),
        onUpdate,
      );
    },
  };
}
