import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  RunWorktreeParams,
  WORKTREE_ACTION_FIELDS,
  WORKTREE_ACTIONS,
  type WorktreeAction,
  type RunWorktreeToolParams,
} from '../../../schemas/runWorktreeTool.ts';
import { invalidRequest } from '../../../services/support/errors.ts';
import type { WorktreeOperations } from '../../worktree/worktreeOperations.ts';
import type { WorktreeRecord } from '../../../types/worktreeRegistry.ts';

export const RUN_WORKTREE_TOOL_NAME = 'run_worktree';

const IMPLEMENTED_ACTIONS: ReadonlySet<string> = new Set(Object.values(WORKTREE_ACTIONS));

const DESCRIPTION = `Create and manage git worktrees, each with its own DoomPi session nested under this one.

Actions:
- spawn_worktree: create a worktree on a new branch and start a session in it. Requires 'branch'. Optional 'baseRef' (defaults to the current branch), 'name' for the rail, 'task' as the first message.
- close_worktree: stop a worktree's session and delete its directory. Requires 'id'. Refuses a dirty tree unless 'force' is true.
- list: every worktree for this repository, with status.
- status: one worktree and its uncommitted files. Requires 'id'.
- merge: merge a worktree's branch into this checkout. Requires 'id'. Refuses when this checkout is dirty.
- prune: remove orphaned worktrees. Pass 'dryRun' to see the plan without destroying anything.
- send: send a message to the other side of a worktree. Requires 'id' and 'message'.
- messages: read messages waiting for you from a worktree. Requires 'id'.

Worktrees live outside the repository, under ~/.pi/.doom/git/worktrees.`;

export interface RunWorktreeToolDetails {
  action: WorktreeAction;
  records?: WorktreeRecord[];
}

/**
 * Rejects a call that is not exactly one documented action shape.
 *
 * Unknown fields are refused rather than ignored. A caller that passes 'branch'
 * to close_worktree has a different operation in mind than the one that would
 * run, and silently dropping the field would carry it out anyway.
 */
export function validateParams(input: unknown): RunWorktreeToolParams {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidRequest('run_worktree parameters must be an object.', 'Call it with one documented action shape.');
  }
  const record = input as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== 'string' || !IMPLEMENTED_ACTIONS.has(action)) {
    throw invalidRequest(
      `Unknown action ${typeof action === 'string' ? `'${action}'` : 'value'}.`,
      `Use one of: ${[...IMPLEMENTED_ACTIONS].join(', ')}.`,
    );
  }
  const allowed = WORKTREE_ACTION_FIELDS[action as WorktreeAction];
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw invalidRequest(
      `action='${action}' does not accept: ${unexpected.join(', ')}.`,
      `Fields for '${action}': ${allowed.join(', ')}.`,
    );
  }
  for (const field of ['branch', 'id'] as const) {
    if (allowed.includes(field) && field in record) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw invalidRequest(`action='${action}' requires a nonblank '${field}'.`, `Pass a ${field}.`);
      }
    }
  }
  if (action === WORKTREE_ACTIONS.spawn_worktree && typeof record.branch !== 'string') {
    throw invalidRequest("action='spawn_worktree' requires 'branch'.", 'Name the branch to create.');
  }
  if (
    (action === WORKTREE_ACTIONS.close_worktree ||
      action === WORKTREE_ACTIONS.status ||
      action === WORKTREE_ACTIONS.merge) &&
    typeof record.id !== 'string'
  ) {
    throw invalidRequest(`action='${action}' requires 'id'.`, 'Call list to see the current ids.');
  }
  return record as RunWorktreeToolParams;
}

function describe(record: WorktreeRecord): string {
  return `${record.id}  ${record.branch}  ${record.status}  ${record.path}`;
}

/** A tool result's content, which Pi expects as content blocks rather than a string. */
function text(...lines: readonly string[]): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: lines.join('\n') }];
}

async function run(
  params: RunWorktreeToolParams,
  operations: WorktreeOperations,
  ctx: ExtensionContext,
  host: { signal?: AbortSignal; onProgress?: (label: string) => void } = {},
): Promise<AgentToolResult<RunWorktreeToolDetails>> {
  const context = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
  switch (params.action) {
    case WORKTREE_ACTIONS.spawn_worktree: {
      const record = await operations.spawn(
        context,
        {
          branch: params.branch,
          ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
          ...(params.name === undefined ? {} : { name: params.name }),
        },
        host,
      );
      return {
        content: text(
          `Worktree ${record.id} created on ${record.branch} from ${record.baseRef}.`,
          `Path: ${record.path}`,
          `Session ${record.sessionId} is starting; it appears nested under this one in the rail.`,
        ),
        details: { action: params.action, records: [record] },
      };
    }
    case WORKTREE_ACTIONS.close_worktree: {
      const record = await operations.close(context, params.id, params.force ?? false);
      return {
        content: text(`Worktree ${record.id} (${record.branch}) closed and removed.`),
        details: { action: params.action, records: [record] },
      };
    }
    case WORKTREE_ACTIONS.list: {
      const records = await operations.list(context);
      return {
        content:
          records.length === 0
            ? text('No worktrees for this repository.')
            : text(`${String(records.length)} worktree(s):`, ...records.map(describe)),
        details: { action: params.action, records },
      };
    }
    case WORKTREE_ACTIONS.status: {
      const { record, dirtyFiles } = await operations.status(context, params.id);
      return {
        content: text(
          describe(record),
          `Session: ${record.sessionId}`,
          dirtyFiles.length === 0
            ? 'Clean.'
            : `${String(dirtyFiles.length)} uncommitted file(s): ${dirtyFiles.slice(0, 20).join(', ')}`,
        ),
        details: { action: params.action, records: [record] },
      };
    }
    case WORKTREE_ACTIONS.merge: {
      const record = await operations.merge(
        context,
        params.id,
        ...(params.message === undefined ? [] : ([params.message] as const)),
      );
      return {
        content: text(`Merged ${record.branch} into this checkout.`),
        details: { action: params.action, records: [record] },
      };
    }
    case WORKTREE_ACTIONS.send: {
      await operations.send(context, params.id, params.message);
      return { content: text(`Message sent to worktree ${params.id}.`), details: { action: params.action } };
    }
    case WORKTREE_ACTIONS.messages: {
      const waiting = await operations.messages(context, params.id);
      return {
        content:
          waiting.length === 0
            ? text('No messages.')
            : text(
                `${String(waiting.length)} message(s):`,
                ...waiting.map((entry) => `[${entry.sentAt}] ${entry.from}: ${entry.text}`),
              ),
        details: { action: params.action },
      };
    }
    case WORKTREE_ACTIONS.prune: {
      const dryRun = params.dryRun ?? false;
      const plan = await operations.prune(context, dryRun);
      const lines = [
        dryRun ? 'Prune plan (nothing was changed):' : 'Pruned:',
        `Remove: ${plan.remove.length === 0 ? 'none' : plan.remove.map((record) => record.id).join(', ')}`,
        `Forget: ${plan.forget.length === 0 ? 'none' : plan.forget.map((record) => record.id).join(', ')}`,
        `Kept, uncommitted work: ${plan.keptDirty.length === 0 ? 'none' : plan.keptDirty.map((record) => record.id).join(', ')}`,
        `Untracked directories, left alone: ${plan.untracked.length === 0 ? 'none' : plan.untracked.join(', ')}`,
        ...(plan.keptBranches.length === 0
          ? []
          : [`Branches kept, they hold commits: ${plan.keptBranches.join(', ')}`]),
      ];
      return { content: text(...lines), details: { action: params.action } };
    }
  }
}

/** Registers `run_worktree` on a Pi host, once. */
export function registerRunWorktreeTool(pi: ExtensionAPI, operations: WorktreeOperations): void {
  const tool: ToolDefinition<typeof RunWorktreeParams, RunWorktreeToolDetails> = {
    name: RUN_WORKTREE_TOOL_NAME,
    label: 'Worktree',
    description: DESCRIPTION,
    parameters: RunWorktreeParams,
    prepareArguments: validateParams,
    // The signal and the progress callback are the host's two answers to a
    // call that takes minutes. Dropping them is what let an interrupted spawn
    // run on with nobody waiting for it, and left the caller staring at
    // nothing while it did.
    execute: async (_id, rawParams, signal, onUpdate, ctx) => {
      const params = validateParams(rawParams);
      return await run(params, operations, ctx, {
        ...(signal === undefined ? {} : { signal }),
        onProgress: (label) => onUpdate?.({ content: text(label), details: { action: params.action } }),
      });
    },
  };
  pi.registerTool(tool);
}
