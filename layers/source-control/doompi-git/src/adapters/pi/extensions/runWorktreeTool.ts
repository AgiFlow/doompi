import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  executeRunWorktreeTool,
  RUN_WORKTREE_DESCRIPTION,
  RUN_WORKTREE_TOOL_NAME,
  validateParams,
  type RunWorktreeToolDetails,
} from '../../runWorktreeTool.ts';
import { RunWorktreeParams, type RunWorktreeToolParams } from '../../../schemas/runWorktreeTool.ts';
import type { WorktreeOperations } from '../../worktree/worktreeOperations.ts';

export { RUN_WORKTREE_TOOL_NAME, validateParams };
export type { RunWorktreeToolDetails };

/** Registers `run_worktree` on a Pi host, once. */
export function registerRunWorktreeTool(pi: ExtensionAPI, operations: WorktreeOperations): void {
  const tool: ToolDefinition<typeof RunWorktreeParams, RunWorktreeToolDetails> = {
    name: RUN_WORKTREE_TOOL_NAME,
    label: 'Worktree',
    description: RUN_WORKTREE_DESCRIPTION,
    parameters: RunWorktreeParams,
    prepareArguments: validateParams,
    // The signal and the progress callback are the host's two answers to a
    // call that takes minutes. Dropping them is what let an interrupted spawn
    // run on with nobody waiting for it, and left the caller staring at
    // nothing while it did.
    execute: async (_id, rawParams, signal, onUpdate, ctx) => {
      const params = validateParams(rawParams) as RunWorktreeToolParams;
      return (await executeRunWorktreeTool(
        params,
        operations,
        {
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
        },
        {
          ...(signal === undefined ? {} : { signal }),
          onProgress: (label) =>
            onUpdate?.({ content: [{ type: 'text', text: label }], details: { action: params.action } }),
        },
      )) as AgentToolResult<RunWorktreeToolDetails>;
    },
  };
  pi.registerTool(tool);
}
