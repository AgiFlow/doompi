import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';
import {
  createGoal,
  goalSummary,
  isContradictoryCompletionSummary,
  transitionGoal,
} from '../../services/stateMachine.ts';
import { parseGoalCommand, validateObjective } from '../../services/parser.ts';
import {
  goalToolNamesForState,
  validateBlockedInput,
  validateCompletionInput,
  type GoalBlockedInput,
  type GoalCompleteInput,
} from '../../services/tools.ts';
import { decodeGoalStateEntries } from '../../services/stateCodec.ts';
import type { ActiveGoal } from '../../types/goal.ts';
import type { MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';

const COMMAND_NAME = 'goal';
const COMMAND_DESCRIPTION = 'Manage persistent goal execution';

type HeadlessFacet = {
  inject: readonly string[];
  apply(context: Context): void | (() => void);
};

const COMPLETE_TOOL = 'goal_complete';
const BLOCKED_TOOL = 'goal_blocked';

function output(value: unknown, isError = false): DoomHeadlessToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

function stateFromEntries(entries: readonly Record<string, unknown>[]): ActiveGoal | undefined {
  return decodeGoalStateEntries(entries).goal;
}

async function skill(): Promise<string> {
  return readFile(new URL('../../../src/prompts/doompi-use-goal/SKILL.md', import.meta.url), 'utf8');
}

export const goalHeadlessFacet: HeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let goal = stateFromEntries(host.context.session.entries());
    let modeOwner: { publish(state: MinorModeState): void; dispose(): void } | undefined;
    let toolRestriction: { dispose(): void } | undefined;

    const modeState = (): MinorModeState => {
      const selected = host.context.selection.minorModes.includes('goal');
      const retained = selected && goal !== undefined && goal.status !== 'complete';
      const condition =
        goal?.status === 'paused'
          ? 'paused'
          : goal?.status === 'blocked'
            ? 'blocked'
            : goal?.status === 'usage_limited' || goal?.status === 'budget_limited'
              ? 'limited'
              : 'ready';
      return {
        activation: selected ? 'active' : 'inactive',
        condition,
        ...(retained ? { detail: goal?.status ?? 'active' } : {}),
        actions: [
          {
            id: 'start',
            enabled: !retained,
            ...(!retained ? {} : { disabledReason: 'A goal is already active.' }),
          },
          {
            id: 'end',
            enabled: retained,
            ...(retained ? {} : { disabledReason: 'No goal is active.' }),
          },
        ],
      };
    };
    const publishMode = (): void => modeOwner?.publish(modeState());
    const updateToolRestriction = (): void => {
      toolRestriction?.dispose();
      toolRestriction = host.registerToolRestriction({
        minorMode: 'goal',
        allowedTools: goalToolNamesForState(goal),
      });
    };

    const persist = async (): Promise<void> => {
      await host.context.session.appendCustomEntry('goal-state', { goal: goal ?? null });
    };
    const selectMode = async (enabled: boolean): Promise<void> => {
      const modes = host.context.selection.minorModes.filter((mode) => mode !== 'goal');
      await host.select({ minorModes: enabled ? [...modes, 'goal'] : modes });
      updateToolRestriction();
      publishMode();
    };
    const requireGoal = (): ActiveGoal => {
      if (!goal) throw new Error('There is no active goal.');
      return goal;
    };
    const start = async (objective: string, budget: number | undefined): Promise<void> => {
      const error = validateObjective(objective);
      if (error) throw new Error(error);
      goal = createGoal(objective.trim(), budget);
      await persist();
      await selectMode(true);
    };
    const end = async (): Promise<void> => {
      goal = undefined;
      await persist();
      await selectMode(false);
    };

    modeOwner = host.registerMinorMode({
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
          {
            id: 'end',
            label: 'End',
            description: 'End the current goal.',
            contexts: ['headless'],
            parameters: [],
          },
        ],
      },
      initialState: modeState(),
      async handleAction(actionId, argumentsValue, execution) {
        execution.signal.throwIfAborted();
        if (actionId === 'start') {
          await start(
            String(argumentsValue.objective ?? ''),
            typeof argumentsValue.budget === 'number' ? argumentsValue.budget : undefined,
          );
          return { message: 'Goal started.' };
        }
        if (actionId === 'end') {
          await end();
          return { message: 'Goal ended.' };
        }
        throw new Error(`Unknown goal mode action: ${actionId}`);
      },
    });
    updateToolRestriction();

    const registrations = [
      host.registerResource({
        when: { minorMode: 'goal' },
        name: 'doompi-use-goal',
        kind: 'skill',
        read: () => skill(),
      }),
      host.registerTool({
        when: { minorMode: 'goal' },
        name: COMPLETE_TOOL,
        label: 'Goal complete',
        description: 'Mark the active goal complete after verifying every requirement.',
        parameters: {
          type: 'object',
          properties: { goal_id: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 } },
          required: ['goal_id', 'summary'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters) {
          try {
            if (!goal || (goal.status !== 'active' && goal.status !== 'budget_limited'))
              throw new Error('Goal completion is not available in the current state.');
            const input = parameters as unknown as Partial<GoalCompleteInput>;
            const validation = validateCompletionInput(goal, input);
            if (!validation.ok) throw new Error(validation.reason);
            const summary = String(input.summary).trim();
            if (isContradictoryCompletionSummary(summary))
              throw new Error('The completion summary contradicts completion.');
            goal = transitionGoal(requireGoal(), 'complete');
            await persist();
            await selectMode(false);
            return output({ completed: true, goal_id: input.goal_id, summary });
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      }),
      host.registerTool({
        when: { minorMode: 'goal' },
        name: BLOCKED_TOOL,
        label: 'Goal blocked',
        description: 'Mark the active goal blocked after the same external blocker recurs with evidence.',
        parameters: {
          type: 'object',
          properties: {
            goal_id: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1 },
            evidence: { type: 'string', minLength: 1 },
            repeated_turns: { type: 'integer', minimum: 3 },
          },
          required: ['goal_id', 'reason', 'evidence', 'repeated_turns'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters) {
          try {
            if (!goal || goal.status !== 'active')
              throw new Error('Goal blocking is not available in the current state.');
            const input = parameters as unknown as Partial<GoalBlockedInput>;
            const validation = validateBlockedInput(goal, input);
            if (!validation.ok) throw new Error(validation.reason);
            goal = transitionGoal(requireGoal(), 'blocked');
            await persist();
            await host.context.session.abort();
            updateToolRestriction();
            publishMode();
            return output({ blocked: true, goal_id: input.goal_id, reason: input.reason, evidence: input.evidence });
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      }),
      host.registerCommand({
        name: COMMAND_NAME,
        description: COMMAND_DESCRIPTION,
        async execute(args, execution) {
          const parsed = parseGoalCommand(args);
          if (typeof parsed === 'string') {
            await execution.client.notify({ body: parsed, level: 'error' });
            return;
          }
          if (parsed.kind === 'show') {
            await execution.client.notify({ body: goal ? goalSummary(goal) : 'No active goal.', level: 'info' });
            return;
          }
          if (parsed.kind === 'start' || parsed.kind === 'edit') {
            let objective = parsed.objective;
            if (!objective) {
              const value = await execution.client.request({ kind: 'input', title: 'Goal objective', multiline: true });
              objective = typeof value === 'string' ? value : '';
            }
            await start(objective, parsed.tokenBudget);
            await execution.client.notify({ body: 'Goal started.', level: 'info' });
            return;
          }
          if (parsed.kind === 'pause' || parsed.kind === 'resume') {
            const current = requireGoal();
            goal = transitionGoal(current, parsed.kind === 'pause' ? 'paused' : 'active');
            await persist();
            updateToolRestriction();
            publishMode();
            await execution.client.notify({ body: `Goal ${parsed.kind}d.`, level: 'info' });
            return;
          }
          await end();
          await execution.client.notify({ body: 'Goal cleared.', level: 'info' });
        },
      }),
      host.registerHook({
        event: 'session_start',
        handle: () => {
          goal = stateFromEntries(host.context.session.entries());
          updateToolRestriction();
          publishMode();
          return undefined;
        },
      }),
      host.registerHook({
        event: 'session_shutdown',
        handle: async () => {
          if (goal) await persist();
        },
      }),
      host.registerHook({
        when: { minorMode: 'goal' },
        event: 'before_agent_start',
        handle(event) {
          if (!goal || goal.status !== 'active') return undefined;
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return { systemPrompt: `${prompt}\n\n[GOAL ACTIVE]\n${goal.text}`.trim() };
        },
      }),
    ];
    return () => {
      toolRestriction?.dispose();
      modeOwner?.dispose();
      registrations.forEach((registration) => registration.dispose());
    };
  },
};

export default goalHeadlessFacet;
