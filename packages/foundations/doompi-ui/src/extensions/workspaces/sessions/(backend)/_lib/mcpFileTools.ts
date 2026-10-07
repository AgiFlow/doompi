import { toDoomHeadlessToolResult, type DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { createFindTool, createLsTool, createWriteTool } from '@earendil-works/pi-coding-agent';

// Pi's `outputSchema` is a TypeBox schema, not an MCP output schema, so it stays off the MCP surface.

export function createMcpWriteTool(
  context: DoomMcpPluginContext,
): DoomHeadlessTool<ReturnType<typeof createWriteTool>['parameters']> {
  const { outputSchema: _outputSchema, ...tool } = createWriteTool(context.execution.cwd);
  return {
    ...tool,
    description:
      "Create or fully overwrite a file in the DoomPi session's repository on the host machine, creating parent folders. Use this server's edit tool to change part of an existing file.",
    executionMode: tool.executionMode === 'sequential' ? 'serial' : tool.executionMode,
    async execute(toolCallId, parameters, signal, onUpdate) {
      return toDoomHeadlessToolResult(
        await tool.execute(
          toolCallId,
          parameters,
          AbortSignal.any([context.signal, signal ?? context.signal]),
          onUpdate && ((partial) => onUpdate(toDoomHeadlessToolResult(partial))),
        ),
      );
    },
  };
}

export function createMcpFindTool(
  context: DoomMcpPluginContext,
): DoomHeadlessTool<ReturnType<typeof createFindTool>['parameters']> {
  const { outputSchema: _outputSchema, ...tool } = createFindTool(context.execution.cwd);
  return {
    ...tool,
    description:
      "Find files by name or glob pattern in the DoomPi session's repository on the host machine (locate paths). Respects .gitignore. Up to 1000 results by default, with output capped at 50KB.",
    executionMode: tool.executionMode === 'sequential' ? 'serial' : tool.executionMode,
    async execute(toolCallId, parameters, signal, onUpdate) {
      return toDoomHeadlessToolResult(
        await tool.execute(
          toolCallId,
          parameters,
          AbortSignal.any([context.signal, signal ?? context.signal]),
          onUpdate && ((partial) => onUpdate(toDoomHeadlessToolResult(partial))),
        ),
      );
    },
  };
}

export function createMcpLsTool(
  context: DoomMcpPluginContext,
): DoomHeadlessTool<ReturnType<typeof createLsTool>['parameters']> {
  const { outputSchema: _outputSchema, ...tool } = createLsTool(context.execution.cwd);
  return {
    ...tool,
    description:
      "List a directory in the DoomPi session's repository on the host machine (folder contents). Sorted, directories end with '/', dotfiles included. Up to 500 entries by default, with output capped at 50KB.",
    executionMode: tool.executionMode === 'sequential' ? 'serial' : tool.executionMode,
    async execute(toolCallId, parameters, signal, onUpdate) {
      return toDoomHeadlessToolResult(
        await tool.execute(
          toolCallId,
          parameters,
          AbortSignal.any([context.signal, signal ?? context.signal]),
          onUpdate && ((partial) => onUpdate(toDoomHeadlessToolResult(partial))),
        ),
      );
    },
  };
}
