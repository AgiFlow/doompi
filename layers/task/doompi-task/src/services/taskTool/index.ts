import type { DoomHeadlessTool, DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import { Check } from 'typebox/value';

import type { TaskMutationParams } from '../../models/task';
import { TaskParamsSchema, type TaskParams, type TaskAssignmentParams } from '../../schemas/task';
import type { DelegationManager } from '../delegation';
import { applyTaskMutation, isCommittingOp, type ReducerAction } from '../reducer';
import { buildAssignmentResult, buildTextResult, buildToolResult, formatAssignmentResults } from '../taskResult';
import type { TaskStore } from '../taskStore';

function output(value: unknown): DoomHeadlessToolResult {
  if (typeof value === 'object' && value !== null && 'content' in value) return value as DoomHeadlessToolResult;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], details: value };
}

function failure(error: unknown): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

export async function reducerAction(
  store: TaskStore,
  action: ReducerAction,
  params: TaskMutationParams,
  maxTasks: number,
): Promise<DoomHeadlessToolResult> {
  const { document, value } = await store.mutate((current) => {
    const result = applyTaskMutation(current, action, params, undefined, maxTasks);
    return { ...(isCommittingOp(result.op) ? { document: result.document } : {}), value: result };
  });
  if (value.op.kind === 'error') throw new Error(value.op.message);
  return buildToolResult(action, params, document, value.op);
}

interface AssignmentItemResult {
  index: number;
  id: number;
  agent: string;
  ok: boolean;
  message: string;
}

async function assignmentBatch(
  manager: DelegationManager,
  assignments: readonly TaskAssignmentParams[],
  signal?: AbortSignal,
): Promise<AssignmentItemResult[]> {
  const result: AssignmentItemResult[] = [];
  for (const [index, assignment] of assignments.entries()) {
    try {
      const outcome = await manager.assign(assignment.id, {
        agent: assignment.agent,
        inlineAgent: assignment.inlineAgent,
        instructions: assignment.instructions,
        relevantFiles: assignment.relevantFiles,
        priorFindings: assignment.priorFindings,
        model: assignment.model,
        ...(assignment.context === 'fork' || assignment.context === 'fresh' ? { context: assignment.context } : {}),
        signal,
      });
      result.push({ index, id: assignment.id, agent: assignment.agent, ...outcome });
    } catch (error) {
      result.push({ index, id: assignment.id, agent: assignment.agent, ok: false, message: String(error) });
    }
  }
  return result;
}

export function createHeadlessTaskTool(
  store: TaskStore,
  manager: DelegationManager,
  maxTasks: number,
): DoomHeadlessTool<typeof TaskParamsSchema> {
  return {
    name: 'task',
    label: 'Task',
    description: 'Maintain a persistent task graph and delegate ready tasks to background agents.',
    parameters: TaskParamsSchema,
    promptSnippet: 'Track complex work persistently and delegate ready tasks',
    executionMode: 'serial',
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      if (!Check(TaskParamsSchema, rawParams)) return failure('Invalid task parameters.');
      const params = rawParams as TaskParams;
      try {
        if (params.action === 'assign') {
          if (!params.assignments?.length) throw new Error('assign requires a non-empty assignments[] array');
          onUpdate?.(
            output(`Delegating ${params.assignments.length} task${params.assignments.length === 1 ? '' : 's'}...`),
          );
          const items = await assignmentBatch(manager, params.assignments, signal);
          const assigned = items.filter((item) => item.ok).map((item) => item.id);
          const text = formatAssignmentResults(items);
          if (assigned.length === 0) throw new Error(text);
          return buildAssignmentResult(params as TaskMutationParams, store.snapshot, text, {
            assigned,
            failed: items.length - assigned.length,
          });
        }
        if (params.action === 'cancel') {
          const outcome = await manager.cancel(params.id ?? Number.NaN);
          if (!outcome.ok) throw new Error(outcome.message);
          return buildTextResult('cancel', params as TaskMutationParams, store.snapshot, outcome.message);
        }
        return reducerAction(store, params.action as ReducerAction, params as TaskMutationParams, maxTasks);
      } catch (error) {
        return failure(error);
      }
    },
  };
}
