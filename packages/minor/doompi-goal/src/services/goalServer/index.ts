import {
  DOOM_BACKGROUND_WORK_CHANGED_EVENT,
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/backgroundWork';
import type { DoomHeadlessHostService, DoomHeadlessTool, DoomHeadlessCommand } from '@agimon-ai/doompi-core/headless';
import { readPackageResource, type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';
import {
  defineMinorMode,
  serverMinorModes,
  type MinorModeOwner,
  type MinorModeState,
} from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';

import { COMMAND_NAME, COMMAND_DESCRIPTION } from '../../constants/goal';
import { cumulativeAssistantTokens, updateGoalUsage } from '../../models/accounting';
import {
  classifyGoalRunFailure,
  nextToolFreeRepeatState,
  resetGoalSafetyEpoch,
  safetyLimitReached,
} from '../../models/safety';
import { decodeGoalStateEntries } from '../../models/stateCodec';
import {
  createGoal,
  formatStatus,
  goalSummary,
  incrementGoal,
  isResumableGoalStatus,
  transitionGoal,
} from '../../models/stateMachine';
import type { ActiveGoal } from '../../types/goal';
import { formatGoalStatusView, GOAL_VIEW_STATUS_KEY } from '../../types/goalView';
import type { GoalHistoryPort } from '../../types/history';
import { buildGoalCheckRequest, GOAL_CHECK_ENTRY, GOAL_CHECK_TIMEOUT_MS, parseGoalCheckResult } from '../goalChecker';
import { GoalHistoryService } from '../history';
import { GoalHistoryStore } from '../historyStore';
import { parseGoalCommand, validateObjective } from '../parser';
import {
  buildContinuePrompt,
  buildGoalPrompt,
  buildGoalSystemPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from '../prompts';
import { DEFAULT_GOAL_SETTINGS } from '../settings';

export function createGoalServer(
  host: DoomHeadlessHostService,
  history?: GoalHistoryPort,
): Omit<DoomServerSessionPlugin, 'tools' | 'commands'> & {
  tools: readonly DoomHeadlessTool[];
  commands: readonly DoomHeadlessCommand[];
} {
  let goal: ActiveGoal | undefined;
  let modeOwner: MinorModeOwner | undefined;
  let revision = 0;
  let runEpoch = 0;
  let runGoalId: string | undefined;
  let activeRunId: unknown;
  let runMessages: unknown[] = [];
  let runToolAttempted = false;
  let runAutomatic = false;
  let pendingAutomatic = false;
  let readyForCheck = false;
  let disposed = false;
  let scheduled = false;
  let checker: AbortController | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  let background: { service: DoomBackgroundWorkService; generation: string } | undefined;
  type CheckLease = { revision: number; goalId: string; background: typeof background };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.catch(() => undefined);
    return result;
  };
  const notify = (body: string, level: 'info' | 'warning' | 'error' = 'info') =>
    Promise.resolve(host.context.client.notify({ body, level }));
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const invalidate = (): void => {
    revision += 1;
    checker?.abort();
  };
  const fence = (): void => {
    invalidate();
    runEpoch += 1;
    runGoalId = undefined;
    activeRunId = undefined;
    readyForCheck = false;
    pendingAutomatic = false;
  };
  const selected = () => (host.context.selection.state?.['minor-mode'] ?? []).includes('goal');
  const modeState = (): MinorModeState => {
    const retained = selected() && goal !== undefined && goal.status !== 'complete';
    return {
      activation: selected() ? 'active' : 'inactive',
      condition:
        goal?.status === 'paused'
          ? 'paused'
          : goal?.status === 'blocked'
            ? 'blocked'
            : goal?.status === 'usage_limited' || goal?.status === 'budget_limited'
              ? 'limited'
              : 'ready',
      ...(retained ? { detail: goal?.status ?? 'active' } : {}),
      actions: [
        { id: 'start', enabled: !retained, ...(!retained ? {} : { disabledReason: 'A goal is already active.' }) },
        { id: 'end', enabled: retained, ...(retained ? {} : { disabledReason: 'No goal is active.' }) },
      ],
    };
  };
  const publishMode = (): void => {
    modeOwner?.publish();
    host.context.client.setStatus(
      GOAL_VIEW_STATUS_KEY,
      goal ? formatGoalStatusView(goal.text, formatStatus(goal) ?? goal.status) : undefined,
    );
  };
  const persist = () => host.context.session.appendCustomEntry('goal-state', { goal: goal ?? null });
  const selectMode = async (enabled: boolean): Promise<void> => {
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== 'goal');
    await host.changeSelection({ axis: 'state', key: 'minor-mode', values: enabled ? [...modes, 'goal'] : modes });
    publishMode();
  };
  const requireGoal = (): ActiveGoal => {
    if (!goal) throw new Error('There is no active goal.');
    return goal;
  };
  const updateUsage = async (current: ActiveGoal): Promise<void> => {
    const entries = await host.context.session.entries();
    updateGoalUsage(current, { sessionManager: { getBranch: () => [...entries] } });
  };
  const archive = async (current: ActiveGoal, reason: string, summary?: string): Promise<void> => {
    history ??= new GoalHistoryService(new GoalHistoryStore(host.context.cwd));
    await history.archive({
      id: current.id,
      objective: current.text,
      status: reason === 'complete' ? 'complete' : current.status,
      reason: summary ?? reason,
      ...(current.tokenBudget === undefined ? {} : { budget: current.tokenBudget }),
      archivedAt: new Date().toISOString(),
      startedAt: new Date(current.startedAt).toISOString(),
      ...(reason === 'complete' ? { completedAt: new Date().toISOString() } : {}),
    });
  };
  const admit = async (text: string, explicit = false): Promise<void> => {
    if (!host.context.session.admitPrompt) throw new Error('The host cannot admit a Goal turn.');
    // Explicit user actions may steer a running agent. An automatic continuation must start an idle run.
    await host.context.session.admitPrompt(text, explicit ? 'steer' : 'prompt');
  };
  const retain = async (
    status: 'paused' | 'blocked' | 'usage_limited' | 'budget_limited',
    reason: string,
  ): Promise<void> => {
    fence();
    goal = transitionGoal(requireGoal(), status);
    await persist();
    publishMode();
    await notify(reason, 'warning');
  };
  const currentLease = async (lease: CheckLease): Promise<boolean> => {
    const matches = () =>
      !disposed &&
      readyForCheck &&
      selected() &&
      revision === lease.revision &&
      goal?.id === lease.goalId &&
      ['active', 'budget_limited'].includes(goal.status) &&
      background !== undefined &&
      background === lease.background &&
      background.service.generation === background.generation;
    if (!matches()) return false;
    try {
      const activity = await host.context.session.activity();
      if (!matches() || !activity.isIdle || activity.hasPendingMessages) return false;
      const snapshot = background!.service.snapshot(host.context.sessionId);
      return matches() && snapshot.items.length === 0 && snapshot.errors.length === 0;
    } catch {
      return false;
    }
  };

  const scheduleCheck = (): void => {
    if (disposed || scheduled || checker) return;
    scheduled = true;
    void enqueue(async () => {
      scheduled = false;
      if (!goal || checker) return;
      const lease: CheckLease = { goalId: goal.id, revision, background };
      if (!(await currentLease(lease))) return;
      const evaluated = { ...goal };
      const controller = new AbortController();
      checker = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(GOAL_CHECK_TIMEOUT_MS)]);
      // Do not hold the command queue while the provider is running.
      void (async () => {
        const entries = await host.context.session.entries();
        const model = (await host.context.session.readModelSettings?.())?.model ?? host.context.model;
        if (!model || !host.context.toolCompletion)
          throw new Error('No tool-capable model is available for the Goal check.');
        if (!(await currentLease(lease))) return undefined;
        signal.throwIfAborted();
        return host.context.toolCompletion.complete(
          `${model.provider}/${model.id}`,
          buildGoalCheckRequest(evaluated, entries, signal),
        );
      })()
        .then((result) =>
          enqueue(async () => {
            if (!result || disposed) return;
            const current = await currentLease(lease);
            await host.context.session.appendCustomEntry(GOAL_CHECK_ENTRY, {
              goalId: evaluated.id,
              ...result,
              discarded: !current,
            });
            if (!current || signal.aborted || !(await currentLease(lease))) return;
            await updateUsage(requireGoal());
            if (signal.aborted || !(await currentLease(lease))) return;
            const decision = parseGoalCheckResult(requireGoal(), result);
            if (decision.tool === 'goal_complete') {
              const completed = requireGoal();
              await archive(completed, 'complete', `${decision.summary}\n\nEvidence: ${decision.evidence}`);
              if (signal.aborted || !(await currentLease(lease))) return;
              fence();
              goal = undefined;
              await persist();
              await selectMode(false);
              await notify(`Goal complete: ${completed.text}`);
              return;
            }
            if (decision.tool === 'goal_blocked') {
              await retain('blocked', `Goal blocked: ${decision.reason}`);
              return;
            }
            const currentGoal = requireGoal();
            if (currentGoal.tokenBudget !== undefined && currentGoal.tokensUsed >= currentGoal.tokenBudget) {
              await retain('budget_limited', 'Goal token budget reached. The unfinished goal has been retained.');
              return;
            }
            const cause = safetyLimitReached(currentGoal, DEFAULT_GOAL_SETTINGS.continuationLimits);
            if (cause) {
              goal = { ...currentGoal, safetyPauseCause: cause };
              await retain('paused', `Goal paused by safety limit: ${cause}. Run /goal resume to continue.`);
              return;
            }
            // Consume readiness before admission so duplicate events cannot send a second prompt.
            fence();
            pendingAutomatic = true;
            try {
              await admit(buildContinuePrompt(currentGoal, decision.instruction));
              goal = incrementGoal(currentGoal);
              await persist();
              publishMode();
            } catch (error) {
              goal = currentGoal;
              await retain('paused', `Goal continuation failed: ${errorText(error)}`);
            }
          }),
        )
        .catch((error: unknown) =>
          enqueue(async () => {
            if (!controller.signal.aborted && (await currentLease(lease)))
              await retain('paused', `Goal check failed: ${errorText(error)} Run /goal resume to retry.`);
          }),
        )
        .finally(() => {
          if (checker !== controller) return;
          checker = undefined;
          if (controller.signal.aborted) scheduleCheck();
        });
    }).catch((error: unknown) => notify(`Goal check could not start: ${errorText(error)}`, 'error'));
  };

  const bindBackgroundWork = (context: Context): void => {
    context.inject([DOOM_BACKGROUND_WORK_SERVICE], (serviceContext) => {
      const service = readDoomBackgroundWorkService(serviceContext);
      if (!service) return undefined;
      const binding = { service, generation: service.generation };
      background = binding;
      invalidate();
      scheduleCheck();
      const unsubscribe = serviceContext.on(DOOM_BACKGROUND_WORK_CHANGED_EVENT, () => {
        if (background !== binding) return;
        invalidate();
        scheduleCheck();
      });
      return () => {
        unsubscribe();
        if (background === binding) {
          background = undefined;
          invalidate();
        }
      };
    });
    context.effect(() =>
      host.subscribeSelection(() => {
        invalidate();
        scheduleCheck();
      }),
    );
  };

  const start = async (objective: string, budget: number | undefined): Promise<boolean> => {
    const error = validateObjective(objective);
    if (error) throw new Error(error);
    if (goal && goal.status !== 'complete') {
      const accepted = await host.context.client.request({
        kind: 'confirm',
        title: 'Replace goal?',
        message: `Current goal: ${goal.text}\n\nNew goal: ${objective}`,
      });
      if (accepted !== true) return false;
      await archive(goal, 'replaced');
    }
    const entries = await host.context.session.entries();
    fence();
    goal = createGoal(objective.trim(), budget, { baselineTokens: cumulativeAssistantTokens(entries) });
    runGoalId = goal.id;
    await persist();
    await selectMode(true);
    try {
      await admit(buildGoalPrompt(goal), true);
    } catch (error) {
      await retain('paused', `Goal kickoff failed: ${errorText(error)}`);
      return false;
    }
    return true;
  };
  const end = async (): Promise<void> => {
    const current = goal;
    if (current) await archive(current, 'cleared');
    fence();
    goal = undefined;
    await persist();
    await selectMode(false);
    if (current) await host.context.session.abort();
  };
  const startSession = async (): Promise<void> => {
    fence();
    goal = decodeGoalStateEntries(await host.context.session.entries()).goal;
    if (goal?.status === 'complete') {
      await archive(goal, 'complete', 'Restored completed goal.');
      goal = undefined;
      await persist();
    }
    if (goal) {
      await selectMode(true);
      runGoalId = goal.id;
      readyForCheck = goal.status === 'active';
    } else publishMode();
    scheduleCheck();
  };
  const settled = (event: Readonly<Record<string, unknown>>): void => {
    const epoch = runEpoch;
    const messages = [...runMessages];
    const toolAttempted = runToolAttempted;
    const automatic = runAutomatic;
    void enqueue(async () => {
      if (
        disposed ||
        epoch !== runEpoch ||
        !goal ||
        goal.id !== runGoalId ||
        readyForCheck ||
        (activeRunId !== undefined && event.runId !== undefined && activeRunId !== event.runId)
      )
        return;
      await updateUsage(goal);
      if (epoch !== runEpoch || !goal || goal.id !== runGoalId) return;
      const failure = classifyGoalRunFailure(messages, event.status, event.error);
      if (failure) {
        await retain(
          failure === 'aborted' ? 'paused' : failure,
          `Goal stopped: ${failure}. Run /goal resume to continue.`,
        );
        return;
      }
      if (automatic) {
        goal.automaticModelTurns += 1;
        Object.assign(goal, nextToolFreeRepeatState(goal, messages, toolAttempted));
      }
      if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget)
        goal = transitionGoal(goal, 'budget_limited');
      await persist();
      if (epoch !== runEpoch) return;
      readyForCheck = true;
      publishMode();
      scheduleCheck();
    }).catch((error: unknown) => notify(`Goal settlement failed: ${errorText(error)}`, 'error'));
  };
  const dispose = (): void => {
    disposed = true;
    fence();
    host.context.client.setStatus(GOAL_VIEW_STATUS_KEY, undefined);
  };

  modeOwner = defineMinorMode<undefined>({
    descriptor: {
      source: '@agimon-ai/doompi-goal',
      id: 'goal',
      label: 'Goal',
      description: 'Persistent objective execution with optional token budgeting.',
      order: 100,
      actions: [
        {
          id: 'start',
          label: 'Start',
          description: 'Start a persistent goal.',
          contexts: ['headless'],
          parameters: [
            { name: 'objective', label: 'Objective', kind: 'string', required: true, minLength: 1 },
            { name: 'budget', label: 'Token budget', kind: 'number', required: false, integer: true, minimum: 1 },
          ],
        },
        { id: 'end', label: 'End', description: 'End the current goal.', contexts: ['headless'], parameters: [] },
      ],
    },
    state: modeState,
    async handleAction(_runtime, actionId, argumentsValue, execution) {
      execution.signal.throwIfAborted();
      invalidate();
      if (actionId === 'start') {
        const started = await enqueue(() =>
          start(
            String(argumentsValue.objective ?? ''),
            typeof argumentsValue.budget === 'number' ? argumentsValue.budget : undefined,
          ),
        );
        return { message: started ? 'Goal started.' : 'Goal unchanged.' };
      }
      if (actionId === 'end') {
        await enqueue(end);
        return { message: 'Goal ended.' };
      }
      throw new Error(`Unknown goal mode action: ${actionId}`);
    },
  }).createOwner(undefined);

  return {
    services: [serverMinorModes([modeOwner]), bindBackgroundWork],
    resources: [
      {
        when: { state: { 'minor-mode': 'goal' }, attribution: { kind: 'minor', mode: 'goal' } },
        name: 'doompi-use-goal',
        kind: 'skill',
        read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-goal/SKILL.md'),
      },
    ],
    tools: [],
    commands: [
      {
        name: COMMAND_NAME,
        description: COMMAND_DESCRIPTION,
        async execute(args, execution) {
          const parsed = parseGoalCommand(args);
          if (typeof parsed === 'string') return notify(parsed, 'error');
          if (parsed.kind === 'show') return notify(goal ? goalSummary(goal) : 'No active goal.');
          invalidate();
          await enqueue(async () => {
            if (parsed.kind === 'start' || parsed.kind === 'edit') {
              let objective = parsed.objective;
              if (!objective) {
                const value = await execution.client.request({
                  kind: 'input',
                  title: 'Goal objective',
                  multiline: true,
                });
                objective = typeof value === 'string' ? value : '';
              }
              const error = validateObjective(objective);
              if (error) throw new Error(error);
              if (parsed.kind === 'start') {
                if (await start(objective, parsed.tokenBudget)) await notify('Goal started.');
              } else {
                readyForCheck = false;
                goal = {
                  ...requireGoal(),
                  text: objective,
                  ...(parsed.tokenBudget === undefined ? {} : { tokenBudget: parsed.tokenBudget }),
                  updatedAt: Date.now(),
                };
                await persist();
                publishMode();
                if (goal.status === 'active') await admit(buildObjectiveUpdatedPrompt(goal), true);
                else await notify(`Goal updated but remains ${goal.status}. Resume explicitly to execute it.`);
              }
              return;
            }
            if (parsed.kind === 'pause') {
              if (requireGoal().status !== 'active') throw new Error('Only active goals can be paused.');
              await updateUsage(requireGoal());
              await retain('paused', 'Goal paused.');
              await host.context.session.abort();
              return;
            }
            if (parsed.kind === 'resume') {
              const current = requireGoal();
              if (!isResumableGoalStatus(current.status))
                throw new Error(`Goal is ${current.status}; it cannot be resumed.`);
              await updateUsage(current);
              if (current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget)
                throw new Error('Goal token budget is still reached.');
              fence();
              goal = resetGoalSafetyEpoch(transitionGoal(current, 'active'));
              runGoalId = goal.id;
              await persist();
              await selectMode(true);
              try {
                await admit(buildResumePrompt(goal, current.status), true);
                await notify('Goal resumed.');
              } catch (error) {
                await retain('paused', `Goal resume failed: ${errorText(error)}`);
              }
              return;
            }
            await end();
            await notify('Goal cleared.');
          }).catch((error: unknown) => notify(errorText(error), 'error'));
        },
      },
    ],
    hooks: [
      { event: 'session_start', handle: () => enqueue(startSession) },
      {
        event: 'session_shutdown',
        handle: async () => {
          fence();
          await enqueue(persist);
        },
      },
      {
        event: 'session_tree',
        handle: () => {
          fence();
          return enqueue(startSession);
        },
      },
      {
        event: 'before_agent_start',
        handle(event) {
          invalidate();
          readyForCheck = false;
          if (!goal || goal.status !== 'active') return undefined;
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return { systemPrompt: `${prompt}\n\n${buildGoalSystemPrompt(goal)}`.trim() };
        },
      },
      {
        event: 'agent_start',
        handle(event) {
          invalidate();
          runEpoch += 1;
          readyForCheck = false;
          activeRunId = event.runId;
          runGoalId = goal?.status === 'active' ? goal.id : undefined;
          runAutomatic = pendingAutomatic;
          pendingAutomatic = false;
          runMessages = [];
          runToolAttempted = false;
        },
      },
      {
        event: 'message_end',
        handle: (event) => {
          if (event.message) runMessages.push(event.message);
        },
      },
      {
        event: 'tool_execution_start',
        handle: () => {
          runToolAttempted = true;
        },
      },
      { event: 'agent_settled', handle: settled },
      {
        event: 'model_select',
        handle: () => {
          invalidate();
          scheduleCheck();
        },
      },
      {
        event: 'session_before_compact',
        handle: () => {
          invalidate();
          readyForCheck = false;
        },
      },
      {
        event: 'session_compact',
        handle: () => {
          invalidate();
          readyForCheck = goal?.status === 'active';
          scheduleCheck();
        },
      },
    ],
    onStop: dispose,
    onDispose: dispose,
  };
}
