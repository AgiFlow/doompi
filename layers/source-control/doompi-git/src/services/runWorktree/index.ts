import {
  RunWorktreeParams,
  WORKTREE_ACTION_FIELDS,
  WORKTREE_ACTIONS,
  type WorktreeAction,
  type RunWorktreeToolParams,
} from '../../schemas/runWorktreeTool';
import type { WorktreeRecord } from '../../types/worktreeRegistry';
import { invalidRequest } from '../errors';
import type { WorktreeOperations } from '../worktreeOperations';

export { RunWorktreeParams };
export type { RunWorktreeToolParams, WorktreeAction };

export const RUN_WORKTREE_TOOL_NAME = 'run_worktree';

const IMPLEMENTED_ACTIONS: ReadonlySet<string> = new Set(Object.values(WORKTREE_ACTIONS));

export const RUN_WORKTREE_DESCRIPTION = `Create and manage git worktrees, each with its own DoomPi session nested under this one.

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

export interface RunWorktreeToolResult {
  content: [{ type: 'text'; text: string }];
  details: RunWorktreeToolDetails;
}

export interface RunWorktreeExecutionContext {
  readonly cwd: string;
  readonly sessionId: string;
}

export interface RunWorktreeExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (label: string) => void;
}

/** Rejects calls that do not match one documented action shape. */
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
  const stringFields = ['baseRef', 'name', 'task', 'message'] as const;
  for (const field of stringFields) {
    if (field in record && (typeof record[field] !== 'string' || record[field].trim() === '')) {
      throw invalidRequest(`action='${action}' requires a nonblank '${field}'.`, `Pass a ${field}.`);
    }
  }
  for (const field of ['force', 'dryRun'] as const) {
    if (field in record && typeof record[field] !== 'boolean') {
      throw invalidRequest(`action='${action}' requires boolean '${field}'.`, `Pass true or false for ${field}.`);
    }
  }
  if (action === WORKTREE_ACTIONS.send && typeof record.message !== 'string') {
    throw invalidRequest("action='send' requires 'message'.", 'Pass the message to send.');
  }
  if (action === WORKTREE_ACTIONS.spawn_worktree && typeof record.branch !== 'string') {
    throw invalidRequest("action='spawn_worktree' requires 'branch'.", 'Name the branch to create.');
  }
  if (
    (action === WORKTREE_ACTIONS.close_worktree ||
      action === WORKTREE_ACTIONS.status ||
      action === WORKTREE_ACTIONS.merge ||
      action === WORKTREE_ACTIONS.send ||
      action === WORKTREE_ACTIONS.messages) &&
    typeof record.id !== 'string'
  ) {
    throw invalidRequest(`action='${action}' requires 'id'.`, 'Call list to see the current ids.');
  }
  return record as RunWorktreeToolParams;
}

function describe(record: WorktreeRecord): string {
  return `${record.id}  ${record.branch}  ${record.status}  ${record.path}`;
}

function text(...lines: readonly string[]): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: lines.join('\n') }];
}

export async function executeRunWorktreeTool(
  params: RunWorktreeToolParams,
  operations: WorktreeOperations,
  context: RunWorktreeExecutionContext,
  options: RunWorktreeExecutionOptions = {},
): Promise<RunWorktreeToolResult> {
  switch (params.action) {
    case WORKTREE_ACTIONS.spawn_worktree: {
      const record = await operations.spawn(
        context,
        {
          branch: params.branch,
          ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
          ...(params.name === undefined ? {} : { name: params.name }),
        },
        options,
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
