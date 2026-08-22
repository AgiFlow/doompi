import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  MSG_UPSERT_FIELD_MISPLACED,
  TaskParamsSchema,
  TOOL_LABEL,
  TOOL_NAME,
  taskActionAcceptsField,
} from '../../schemas/task.ts';
import type { AssignOptions, DelegationManager, DelegationOutcome } from '../../services/delegation/manager.ts';
import { applyTaskMutation, isCommittingOp, type ReducerAction } from '../../services/store/reducer.ts';
import type { TaskStore } from '../../adapters/store/taskStore';
import type { TaskAction, TaskAssignment, TaskMutationParams } from '../../services/store/types.ts';
import { renderTaskCall, renderTaskResult } from '../../tui/format.ts';
import { DEFAULT_MAX_TASKS } from '../../types/config.ts';
import { TASK_EVENT, type TaskFailureReporter } from '../../types/telemetry.ts';
import { DEFAULT_PROMPT_GUIDELINES } from './promptGuidelines.ts';
import {
  type AssignmentItemResult,
  buildAssignmentResult,
  buildTextResult,
  buildToolResult,
  formatAssignmentResults,
  formatUpsertFailureText,
  type ToolResult,
} from './responseEnvelope.ts';

export { DEFAULT_PROMPT_GUIDELINES } from './promptGuidelines.ts';

/** @deprecated Task usage policy now lives only in the tool description. */
export const DEFAULT_PROMPT_SNIPPET =
  'Track only complex, multi-step jobs that benefit from persistent progress or delegation; skip simple work';

export interface TaskToolDependencies {
  store: TaskStore;
  delegation: DelegationManager;
  maxTasks?: number;
  onChange?: () => void;
  report?: TaskFailureReporter;
  waitUntilReady?: (context: ExtensionContext, signal?: AbortSignal) => Promise<void>;
}

const ACTION_ATTRIBUTE = 'tool.action';
const TASK_ID_ATTRIBUTE = 'task.id';
const REDUCER_ACTIONS = new Set<TaskAction>(['upsert', 'list', 'get', 'delete', 'clear']);

class TaskToolExecutionError extends Error {}

function actionableTaskError(action: TaskAction, message: string): TaskToolExecutionError {
  return new TaskToolExecutionError(
    [
      `Task ${action} failed: ${message}`,
      '',
      'Options:',
      '- List the task board and inspect the current ids, states, and blockers.',
      '- Correct the arguments or state conflict, then retry once.',
      '- Ask the user before cancelling work or changing dependencies to recover.',
    ].join('\n'),
  );
}

/**
 * Reject a field that belongs to a different action.
 *
 * The params schema is flat and shared across every action, so this is the only
 * place `{"action":"upsert","id":3}` can be caught — and it must be, because
 * the entry it carries has no id and would silently create a duplicate task.
 */
function rejectStrayFields(action: TaskAction, params: TaskMutationParams): void {
  const stray = Object.keys(params).filter((key) => params[key] !== undefined && !taskActionAcceptsField(action, key));
  if (stray.length === 0) return;
  const hint = action === 'upsert' ? ` ${MSG_UPSERT_FIELD_MISPLACED}` : '';
  throw actionableTaskError(action, `${action} does not accept ${stray.join(', ')}.${hint}`);
}

/** assignments[] is the only assign contract, even when it contains one task. */
function resolveAssignments(params: TaskMutationParams): TaskAssignment[] {
  const assignments = params.assignments;
  if (!assignments || assignments.length === 0) {
    throw actionableTaskError('assign', 'assign requires a non-empty assignments[] array');
  }
  return assignments;
}

function assignOptions(request: TaskAssignment, signal: AbortSignal | undefined): AssignOptions {
  return {
    agent: request.agent,
    inlineAgent: request.inlineAgent,
    instructions: request.instructions,
    relevantFiles: request.relevantFiles,
    priorFindings: request.priorFindings,
    model: request.model,
    context: request.context,
    signal,
  };
}

async function executeAssignmentBatch(
  delegation: DelegationManager,
  assignments: readonly TaskAssignment[],
  signal: AbortSignal | undefined,
  report: TaskFailureReporter | undefined,
): Promise<AssignmentItemResult[]> {
  const results: AssignmentItemResult[] = [];
  for (const [index, assignment] of assignments.entries()) {
    let outcome: DelegationOutcome;
    try {
      outcome = await delegation.assign(assignment.id, assignOptions(assignment, signal));
    } catch (error) {
      report?.error(TASK_EVENT.toolFailed, error, {
        [ACTION_ATTRIBUTE]: 'assign',
        [TASK_ID_ATTRIBUTE]: assignment.id,
      });
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    results.push({ index, id: assignment.id, agent: assignment.agent, ...outcome });
  }
  return results;
}

/** Run an action through the reducer, persisting only when it produced a change. */
async function executeReducerAction(
  store: TaskStore,
  action: ReducerAction,
  params: TaskMutationParams,
  maxTasks: number,
): Promise<ToolResult> {
  const { document, value } = await store.mutate((current) => {
    const result = applyTaskMutation(current, action, params, undefined, maxTasks);
    return {
      ...(isCommittingOp(result.op) ? { document: result.document } : {}),
      value: result,
    };
  });
  if (value.op.kind === 'error') throw actionableTaskError(action, value.op.message);
  // An upsert that applied nothing is a failed call: it wrote nothing and left
  // `rev` alone, so it must not read to the model as a success. A batch where
  // some entries landed returns normally — that is what partial apply means.
  if (value.op.kind === 'upsert' && value.op.applied === 0) {
    throw actionableTaskError(action, formatUpsertFailureText(value.op));
  }
  // `document` is the committed document, so `details.rev` matches what landed
  // on disk; `value.document` is the pre-write copy and lags by one.
  return buildToolResult(action, params, document, value.op);
}

export function registerTaskTool(pi: ExtensionAPI, dependencies: TaskToolDependencies): void {
  const { store, delegation, maxTasks = DEFAULT_MAX_TASKS } = dependencies;

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      'Track complex jobs with a shared task list and delegate tracked work to subagents. Use this only when persistent coordination is useful, such as work with dependencies, parallel workstreams, or a long-running plan. Do not use it for simple requests, routine edits, straightforward command sequences, or merely because the user listed multiple steps. Actions: upsert (write tasks: an entry with an id changes that task and one without an id creates one), list, get, delete (tombstone), clear (close/reset the list), assign (hand tasks through assignments[] to named background subagents), cancel (stop a delegated run). upsert and assign apply entries independently: successes remain committed or delegated and failures are reported by array index. Batch a plan and independent assignments, but report progress one task at a time. Status: pending → in_progress → completed, plus failed and a deleted tombstone. The list is shared within the current session tree, including delegated subagents, while unrelated sessions start empty. Session stores persist until retention cleanup.',
    promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
    parameters: TaskParamsSchema,
    // Task rows carry their own status colors. Owning the shell prevents Pi's
    // pending/success/error background fill from obscuring those row states.
    renderShell: 'self',

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action as TaskAction;
      const mutationParams = params as TaskMutationParams;

      try {
        await dependencies.waitUntilReady?.(ctx, signal);
        rejectStrayFields(action, mutationParams);
        if (REDUCER_ACTIONS.has(action)) {
          const result = await executeReducerAction(store, action as ReducerAction, mutationParams, maxTasks);
          dependencies.onChange?.();
          return result;
        }

        if (action === 'assign') {
          const assignments = resolveAssignments(mutationParams);
          const first = assignments[0];
          const progress =
            assignments.length === 1 && first
              ? `Delegating task #${first.id}...`
              : `Delegating ${assignments.length} tasks...`;
          onUpdate?.(buildTextResult(action, mutationParams, store.snapshot, progress));
          const results = await executeAssignmentBatch(delegation, assignments, signal, dependencies.report);
          dependencies.onChange?.();
          const text = formatAssignmentResults(results);
          const assigned = results.flatMap((item) => (item.ok ? [item.id] : []));
          if (assigned.length === 0) throw actionableTaskError(action, text);
          return buildAssignmentResult(mutationParams, store.snapshot, text, {
            assigned,
            failed: results.length - assigned.length,
          });
        }

        onUpdate?.(
          buildTextResult(
            action,
            mutationParams,
            store.snapshot,
            `Requesting cancellation for task #${mutationParams.id ?? 'unknown'}...`,
          ),
        );
        const outcome = await delegation.cancel(mutationParams.id ?? Number.NaN);
        dependencies.onChange?.();
        if (!outcome.ok) throw actionableTaskError(action, outcome.message);
        return buildTextResult(action, mutationParams, store.snapshot, outcome.message, undefined);
      } catch (error) {
        // Rethrown so pi still renders the failure to the model; recorded
        // because this is where a store fault becomes visible to the user.
        dependencies.report?.error(TASK_EVENT.toolFailed, error, {
          [ACTION_ATTRIBUTE]: action,
          ...(mutationParams.id === undefined ? {} : { [TASK_ID_ATTRIBUTE]: mutationParams.id }),
        });
        if (error instanceof TaskToolExecutionError) throw error;
        throw actionableTaskError(action, error instanceof Error ? error.message : String(error));
      }
    },

    // Render hooks receive no session identity, so they read the store snapshot
    // that the executing session last loaded. That is the foreground session's
    // own view, which is exactly what its transcript should show.
    renderCall(args, theme, _context) {
      return renderTaskCall(args as never, theme, store.snapshot.tasks);
    },

    renderResult(result, options, theme, _context) {
      return renderTaskResult(result, options, theme);
    },
  });
}
