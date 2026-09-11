import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { DOOM_DELEGATION_SERVICE, readDoomDelegationService } from '@agimon-ai/doompi-extension-contracts/delegation';
import type { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import { TaskParamsSchema, type TaskParams, type TaskAssignmentParams } from '../../schemas/task.ts';
import { TaskStore } from '../../adapters/store/taskStore.ts';
import { resolveSessionKey } from '../../adapters/store/paths.ts';
import { createNodeDelegationPlatform } from '../node/delegationPlatform.ts';
import { DelegationManager } from '../../services/delegation/manager.ts';
import { applyTaskMutation, isCommittingOp, type ReducerAction } from '../../services/store/reducer.ts';
import type { TaskMutationParams } from '../../services/store/types.ts';
import {
  buildAssignmentResult,
  buildTextResult,
  buildToolResult,
  formatAssignmentResults,
} from '../../services/taskResult.ts';
import { getMaxTasks, getDelegationTimeoutMs, getStoreTtlMs } from '../../types/config.ts';
import { removeLegacyStoreDirectoryAsync, sweepStoreFilesAsync } from '../../adapters/store/paths.ts';
import { TASKS_CHANNEL_TYPE } from '../../types/webTasks.ts';
import type { DoomHeadlessTool } from '@agimon-ai/doompi-extension-contracts/headless';

const SOURCE = '@agimon-ai/doompi-task';

type HeadlessFacet = {
  inject: readonly string[];
  apply(context: Context): void | (() => void);
};

function output(value: unknown): DoomHeadlessToolResult {
  if (typeof value === 'object' && value !== null && 'content' in value) return value as DoomHeadlessToolResult;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], details: value };
}

function failure(error: unknown): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

async function reducerAction(
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

function createTaskTool(
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

export const taskHeadlessFacet: HeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE, DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const execution = host.context;
    const serverHost = requireDoomServerHost(context);
    if (serverHost.context.directEvents === undefined)
      throw new Error('Task headless facet requires the session direct event bus.');
    const directEvents = serverHost.context.directEvents;
    const maxTasks = getMaxTasks(execution.environment);
    const store = new TaskStore({
      env: execution.environment,
      onCommitted: (_previous, committed) => {
        execution.client.setStatus(SOURCE, `tasks: ${committed.tasks.length}`);
        directEvents.publish(TASKS_CHANNEL_TYPE, execution.sessionId, committed);
      },
    });
    store.configureSession(resolveSessionKey(execution.sessionId, execution.environment));
    const manager = new DelegationManager({
      store,
      cwd: execution.cwd,
      platform: createNodeDelegationPlatform(execution.environment),
      getSessionId: () => execution.sessionId,
      notify: (message) => void execution.client.notify({ body: message.content, level: 'info' }),
      onChange: () => execution.client.setStatus(SOURCE, `tasks: ${store.snapshot.tasks.length}`),
      runTimeoutMs: getDelegationTimeoutMs(execution.environment),
      onNotifyError: (error) => void execution.client.notify({ body: String(error), level: 'warning' }),
    });
    context.inject([DOOM_DELEGATION_SERVICE], (serviceContext) => {
      const service = readDoomDelegationService(serviceContext);
      if (service) manager.bind(serviceContext, service);
    });
    const registrations = [
      host.registerTool(createTaskTool(store, manager, maxTasks)),
      host.registerCommand({
        name: 'tasks',
        description: 'List or clear the persistent task graph.',
        async execute(args, commandContext) {
          const action = args.trim() === 'clear' ? 'clear' : 'list';
          const response = await reducerAction(store, action, { action }, maxTasks);
          const content = response.content[0];
          await commandContext.client.notify({
            body: content?.type === 'text' ? content.text : 'No tasks',
            level: 'info',
          });
        },
      }),
      host.registerResource({
        name: 'doompi/task-board',
        kind: 'context',
        read: () => JSON.stringify(store.snapshot, null, 2),
      }),
      host.registerActivity({
        name: SOURCE,
        async start(activityContext) {
          store.configureSession(resolveSessionKey(activityContext.sessionId, activityContext.environment));
          await removeLegacyStoreDirectoryAsync(store.storePath, activityContext.cwd);
          if (!activityContext.environment.DOOM_TASK_STORE_PATH)
            await sweepStoreFilesAsync(store.storePath, getStoreTtlMs(activityContext.environment));
          await store.readAsync();
          await manager.reconcile();
          host.context.client.setStatus(SOURCE, `tasks: ${store.snapshot.tasks.length}`);
          return () => {
            manager.reset();
            host.context.client.setStatus(SOURCE, undefined);
          };
        },
      }),
    ];
    return () => {
      for (const registration of registrations.reverse()) registration.dispose();
      manager.dispose();
      store.dispose();
    };
  },
};

export default taskHeadlessFacet;
