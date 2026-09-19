import type { DoomHeadlessTool, DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { RunWorktreeToolSchema, type RunWorktreeToolParams } from '../../../../../schemas/runWorktreeTool';
import { createWorktreeGit } from '../../../../../services/gitCli';
import {
  executeRunWorktreeTool,
  RUN_WORKTREE_DESCRIPTION,
  RUN_WORKTREE_TOOL_NAME,
  validateParams,
} from '../../../../../services/runWorktree';
import { createWorktreeOperations } from '../../../../../services/worktreeOperations';

function progressResult(action: RunWorktreeToolParams['action'], label: string): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text: label }], details: { action } };
}

export default defineMcpTool(() => {
  const operations = createWorktreeOperations({ git: createWorktreeGit() });
  const tool: DoomHeadlessTool<typeof RunWorktreeToolSchema> = {
    name: RUN_WORKTREE_TOOL_NAME,
    label: 'Worktree',
    description: RUN_WORKTREE_DESCRIPTION,
    parameters: RunWorktreeToolSchema,
    promptSnippet: 'Create and manage Git worktree sessions',
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal, onUpdate, execution) {
      const params = validateParams(parameters) as RunWorktreeToolParams;
      return executeRunWorktreeTool(params, operations, execution, {
        ...(signal === undefined ? {} : { signal }),
        onProgress: (label) => onUpdate?.(progressResult(params.action, label)),
      });
    },
  };
  return tool;
});
