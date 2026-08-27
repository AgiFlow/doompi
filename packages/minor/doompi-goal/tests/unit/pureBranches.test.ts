import { describe, expect, it, vi } from 'vitest';
import { registerGoalCommand } from '../../src/commands/goalCommand.ts';
import {
  assistantUsageTokens,
  checkpointGoalActiveTime,
  currentTokenTotal,
  formatDuration,
  formatTokenCount,
  nonNegativeFiniteNumber,
  normalizeTokenBudget,
  updateGoalUsage,
} from '../../src/services/accounting.ts';
import {
  completeGoalArguments,
  parseGoalCommand,
  parseTokenBudget,
  validateObjective,
} from '../../src/services/parser.ts';
import {
  buildContinuePrompt,
  buildGoalPrompt,
  buildGoalSystemPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from '../../src/services/prompts.ts';
import { GoalRuntimeModel } from '../../src/services/runtime.ts';
import {
  nextToolFreeRepeatState,
  outputFingerprint,
  resetGoalSafetyEpoch,
  safetyLimitReached,
  shouldPauseForSafety,
} from '../../src/services/safety.ts';
import { DEFAULT_GOAL_SETTINGS, decodeGoalSettings, normalizeGoalSettings } from '../../src/services/settings.ts';
import {
  decodeGoalStateEntries,
  isCanonicalGoalState,
  loadGoalStateFromSession,
  normalizeLoadedGoal,
  serializeGoalState,
} from '../../src/services/stateCodec.ts';
import {
  createGoal,
  editedGoalStatus,
  formatBudget,
  formatStatus,
  getExecutionState,
  goalIdRejectionReason,
  goalSummary,
  incrementGoal,
  isContradictoryCompletionSummary,
  isGoalToolAllowedForState,
  isResumableGoalStatus,
  isRetainedGoalStatus,
  nextGoalInstance,
  transitionGoal,
} from '../../src/services/stateMachine.ts';
import {
  addGoalTools,
  filterGoalTools,
  goalToolNamesForState,
  validateBlockedInput,
  validateCompletionInput,
  validateGoalId,
} from '../../src/services/tools.ts';
import { GoalHistoryService } from '../../src/services/history/historyService.ts';
import type { ActiveGoal } from '../../src/types/goal.ts';
import type { GoalHistoryEntry, GoalHistoryPort } from '../../src/types/history.ts';

describe('accounting and parser branches', () => {
  it('normalizes malformed usage and updates elapsed/token accounting', () => {
    expect(nonNegativeFiniteNumber(-1)).toBe(0);
    expect(nonNegativeFiniteNumber(Number.NaN)).toBe(0);
    expect(normalizeTokenBudget(1.5)).toBeUndefined();
    expect(normalizeTokenBudget(0)).toBeUndefined();
    expect(assistantUsageTokens(undefined)).toBe(0);
    expect(assistantUsageTokens({ input: 2, output: -1, cacheRead: 3, cacheWrite: 4 })).toBe(9);
    expect(assistantUsageTokens({ totalTokens: -1, input: 2 })).toBe(2);
    const context = {
      sessionManager: {
        getBranch: () => [
          { type: 'message', message: { role: 'user', usage: { totalTokens: 100 } } },
          { type: 'message', message: { role: 'assistant', usage: { input: 4, output: 6 } } },
          { type: 'other', message: { role: 'assistant', usage: { totalTokens: 100 } } },
        ],
      },
    };
    expect(currentTokenTotal(context)).toBe(10);
    const goal = createGoal('accounting', undefined, { id: 'a', now: 1000, baselineTokens: 2 });
    checkpointGoalActiveTime(goal, 2500, false);
    expect(goal.timeUsedSeconds).toBe(1.5);
    expect(goal.activeStartedAt).toBeUndefined();
    updateGoalUsage(goal, context, 3000, true);
    expect(goal.tokensUsed).toBe(8);
    expect(goal.activeStartedAt).toBe(3000);
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(3600)).toBe('1h0m');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(1000000)).toBe('1m');
  });

  it('covers completion and parser error paths', () => {
    expect(completeGoalArguments('')).toHaveLength(6);
    expect(completeGoalArguments('a')).toBeNull();
    expect(completeGoalArguments('edit ')).toEqual([
      { value: 'edit --tokens ', label: '--tokens', description: 'Set a token budget' },
    ]);
    expect(completeGoalArguments('edit --')).toEqual([
      { value: 'edit --tokens ', label: '--tokens', description: 'Set a token budget' },
    ]);
    expect(completeGoalArguments('status trailing')).toBeNull();
    expect(parseGoalCommand('pause extra')).toContain('Usage');
    expect(parseGoalCommand('resume extra')).toContain('Usage');
    expect(parseGoalCommand('stop')).toEqual({ kind: 'clear' });
    expect(parseGoalCommand('clear x')).toContain('Usage');
    expect(parseGoalCommand('edit')).toContain('Usage');
    expect(parseGoalCommand('--tokens')).toContain('Usage');
    expect(parseGoalCommand('--tokens bad task')).toContain('Invalid');
    // The retired queue verbs are no longer recognised, so they read as what
    // they literally are: the opening words of an objective.
    expect(parseGoalCommand('add write the changelog')).toEqual({
      kind: 'start',
      objective: 'add write the changelog',
      tokenBudget: undefined,
    });
    expect(parseTokenBudget('1.2m')).toBe(1200000);
    expect(parseTokenBudget('0')).toBeUndefined();
    expect(parseTokenBudget('9e3')).toBeUndefined();
    expect(validateObjective('   ')).toContain('Usage');
    expect(validateObjective('x'.repeat(4001))).toContain('too long');
  });
});

describe('prompts, settings, tools, and safety branches', () => {
  const goal = createGoal('objective < &', 1000, { id: 'goal-1', now: 1000 });

  it('keeps visible Goal messages concise and full context in the system prompt', () => {
    expect(buildGoalPrompt(goal)).toBe('[goal]\nobjective < &');
    expect(buildObjectiveUpdatedPrompt(goal)).toBe('[goal]\nobjective < &');
    expect(buildResumePrompt(goal, 'usage_limited')).toBe('[goal]\nobjective < &');
    expect(buildResumePrompt(goal, 'budget_limited')).toBe('[goal]\nobjective < &');
    expect(buildContinuePrompt(goal)).toBe('[goal]\nContinue.');
    const systemPrompt = buildGoalSystemPrompt(goal);
    expect(systemPrompt).toContain('<goal_objective>');
    expect(systemPrompt).toContain('objective &lt; &amp;');
    expect(systemPrompt).toContain('<goal_id>');
    expect(systemPrompt).toContain('Respect the goal token budget');
    expect(systemPrompt).toContain('Goal-mode rules:');
  });

  it('decodes settings and validates every strict tool input branch', () => {
    expect(decodeGoalSettings(undefined).kind).toBe('invalid');
    expect(
      normalizeGoalSettings({
        toolVisibility: 'operational',
        continuationLimits: { automaticTurns: 2, noProgressTurns: null },
      }),
    ).toMatchObject({ continuationLimits: { automaticTurns: 2, noProgressTurns: null } });
    // `experimental` opted into the removed queue; a file that still names it
    // loads as if it did not, rather than being refused.
    expect(normalizeGoalSettings({ toolVisibility: 'operational', experimental: { goals: true } })).toEqual(
      DEFAULT_GOAL_SETTINGS,
    );
    expect(
      normalizeGoalSettings({ toolVisibility: 'operational', continuationLimits: { automaticTurns: 0 } }),
    ).toBeUndefined();
    expect(decodeGoalSettings({ toolVisibility: 'operational' }).kind).toBe('loaded');
    expect(validateGoalId(undefined, 'id')).toMatchObject({ ok: false });
    expect(validateGoalId(goal, '')).toMatchObject({ reason: 'missing goal_id' });
    expect(validateGoalId(goal, 'other')).toMatchObject({ reason: 'goal_id does not match the active goal' });
    expect(validateCompletionInput(goal, { goal_id: goal.id, summary: '' })).toMatchObject({ ok: false });
    expect(
      validateBlockedInput(goal, { goal_id: goal.id, reason: '', evidence: 'e', repeated_turns: 3 }),
    ).toMatchObject({ ok: false });
    expect(
      validateBlockedInput(goal, { goal_id: goal.id, reason: 'r'.repeat(1001), evidence: 'e', repeated_turns: 3 }),
    ).toMatchObject({ ok: false });
    expect(
      validateBlockedInput(goal, { goal_id: goal.id, reason: 'r', evidence: '', repeated_turns: 3 }),
    ).toMatchObject({ ok: false });
    expect(
      validateBlockedInput(goal, { goal_id: goal.id, reason: 'r', evidence: 'e'.repeat(4001), repeated_turns: 3 }),
    ).toMatchObject({ ok: false });
    expect(
      validateBlockedInput(goal, { goal_id: goal.id, reason: 'r', evidence: 'e', repeated_turns: 2 }),
    ).toMatchObject({ ok: false });
    expect(goalToolNamesForState(undefined)).toEqual([]);
    expect(filterGoalTools(['goal_complete', 'read', 'goal_blocked'])).toEqual(['read']);
    expect(addGoalTools(['goal_blocked', 'read'], 'budget_limited')).toEqual(['read', 'goal_complete']);
  });

  it('covers safety fingerprints and thresholds', () => {
    expect(outputFingerprint([])).toBeUndefined();
    expect(outputFingerprint([{ role: 'user', content: 'ignored' }])).toBeUndefined();
    expect(
      nextToolFreeRepeatState(
        { toolFreeRepeatCount: 5, lastToolFreeOutputFingerprint: 'x' },
        [{ role: 'assistant', content: '' }],
        false,
      ).toolFreeRepeatCount,
    ).toBe(0);
    expect(
      nextToolFreeRepeatState(
        { toolFreeRepeatCount: 5, lastToolFreeOutputFingerprint: 'x' },
        [{ role: 'assistant', text: 'worked' }],
        true,
      ),
    ).toMatchObject({ toolFreeRepeatCount: 0 });
    expect(
      safetyLimitReached(
        { automaticModelTurns: 0, toolFreeRepeatCount: 0 },
        { automaticTurns: null, noProgressTurns: null },
      ),
    ).toBeUndefined();
    expect(
      shouldPauseForSafety(
        { status: 'paused', automaticModelTurns: 5, toolFreeRepeatCount: 5 },
        { automaticTurns: 1, noProgressTurns: 1 },
      ),
    ).toBe(false);
    expect(
      shouldPauseForSafety(
        { status: 'active', automaticModelTurns: 5, toolFreeRepeatCount: 0 },
        { automaticTurns: 1, noProgressTurns: null },
      ),
    ).toBe(true);
    expect(resetGoalSafetyEpoch({ ...goal, automaticModelTurns: 5, toolFreeRepeatCount: 2 }, 20)).toMatchObject({
      automaticModelTurns: 0,
      toolFreeRepeatCount: 0,
      updatedAt: 20,
    });
  });
});

describe('state-machine branches', () => {
  it('covers state status formatting, summaries, and transitions', () => {
    const base = createGoal('state', 100, { id: 'state', now: 10 });
    for (const status of ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'] as const) {
      const transitioned = transitionGoal({ ...base, status }, status, 20);
      expect(isRetainedGoalStatus(status)).toBe(status !== 'complete');
      expect(isResumableGoalStatus(status)).toBe(
        ['paused', 'blocked', 'usage_limited', 'budget_limited'].includes(status),
      );
      expect(formatStatus(transitioned)).toBeDefined();
    }
    expect(formatStatus(undefined)).toBeUndefined();
    expect(formatBudget({ tokensUsed: 10, tokenBudget: 100 })).toBe('10/100');
    expect(editedGoalStatus('complete')).toBe('active');
    expect(editedGoalStatus('paused')).toBe('paused');
    expect(nextGoalInstance(base, 30, 'new')).toMatchObject({ id: 'new', iteration: 0, tokensUsed: 0 });
    expect(incrementGoal(base, 30)).toMatchObject({ iteration: 1, updatedAt: 30 });
    expect(getExecutionState({ goal: undefined })).toBe('dormant');
    expect(getExecutionState({ goal: { ...base, status: 'paused' } })).toBe('retained');
    expect(goalIdRejectionReason(base, '')).toContain('missing');
    expect(goalIdRejectionReason(base, 'other')).toContain('does not match');
    expect(goalIdRejectionReason(base, base.id)).toBeUndefined();
    expect(isGoalToolAllowedForState('active', 'goal_blocked')).toBe(true);
    expect(isGoalToolAllowedForState('budget_limited', 'goal_blocked')).toBe(false);
    expect(isContradictoryCompletionSummary('not yet complete')).toBe(true);
    expect(isContradictoryCompletionSummary('could not complete')).toBe(false);
    expect(goalSummary({ ...base, safetyPauseCause: 'no_progress' })).toContain('Safety pause: no progress');
    expect(goalSummary(base)).toContain('Goal: state');
  });
});

describe('session codec and runtime commits', () => {
  it('decodes canonical, legacy, malformed, and clear states', () => {
    const active = createGoal('codec', undefined, { id: 'codec', now: 10 });
    const canonical = serializeGoalState(active);
    expect(canonical).toEqual({ goal: active });
    expect(isCanonicalGoalState(canonical)).toBe(true);
    expect(decodeGoalStateEntries([{ type: 'custom', customType: 'goal-state', data: canonical }])).toMatchObject({
      source: 'canonical',
      goal: { id: 'codec' },
    });
    expect(
      decodeGoalStateEntries([{ type: 'custom', customType: 'goals-state', data: { goals: [active] } }]),
    ).toMatchObject({ source: 'legacy-goals', goal: { id: 'codec' } });
    expect(decodeGoalStateEntries([{ type: 'custom', customType: 'goals-state', data: { goals: [] } }])).toMatchObject({
      source: 'legacy-goals',
      malformed: false,
    });
    expect(
      decodeGoalStateEntries([{ type: 'custom', customType: 'goal-state', data: { goal: { id: '' } } }]),
    ).toMatchObject({ malformed: true });
    expect(
      decodeGoalStateEntries([
        { type: 'custom', customType: 'goal-state', data: { goal: { ...active, status: 'complete' } } },
      ]),
    ).toMatchObject({ source: 'canonical', goal: undefined, malformed: false });
    expect(
      normalizeLoadedGoal({ ...active, iteration: -1, tokensUsed: -1, activeStartedAt: undefined }, 99),
    ).toMatchObject({ iteration: 0, tokensUsed: 0, startedAt: 10 });
    expect(
      loadGoalStateFromSession({
        sessionManager: { getEntries: () => [{ type: 'custom', customType: 'goal-state', data: { goal: null } }] },
      }),
    ).toMatchObject({ source: 'canonical' });
    expect(loadGoalStateFromSession({})).toMatchObject({ source: 'none' });
  });

  it('keeps the objective out of state a session persisted before the queue was removed', () => {
    // The fields the queue wrote are read past, not rejected, and a goal it had
    // parked comes back paused rather than being lost to a fail-closed decode.
    const active = createGoal('survivor', undefined, { id: 'survivor', now: 10 });
    const parked = { ...active, id: 'parked', text: 'parked', status: 'queued' as unknown as ActiveGoal['status'] };

    expect(
      decodeGoalStateEntries([
        {
          type: 'custom',
          customType: 'goal-state',
          data: {
            goal: active,
            queue: [parked],
            pendingAction: { kind: 'advance', goalId: 'survivor', reason: 'complete', completedText: 'survivor' },
          },
        },
      ]),
    ).toMatchObject({ source: 'canonical', malformed: false, goal: { id: 'survivor', status: 'active' } });

    expect(
      decodeGoalStateEntries([{ type: 'custom', customType: 'goal-state', data: { goal: parked } }]),
    ).toMatchObject({ source: 'canonical', malformed: false, goal: { id: 'parked', status: 'paused' } });

    // A legacy entry's tail was the queue; only the head is a goal now.
    expect(
      decodeGoalStateEntries([
        { type: 'custom', customType: 'goals-state', data: { goals: [active, parked], pendingUnshift: {} } },
      ]),
    ).toMatchObject({ source: 'legacy-goals', goal: { id: 'survivor' } });
  });

  it('persists runtime state before exposing snapshots', () => {
    const persisted: unknown[] = [];
    const model = new GoalRuntimeModel({ persist: (state) => persisted.push(state) });
    const active = createGoal('runtime', undefined, { id: 'runtime', now: 10 });
    expect(model.snapshot()).toMatchObject({ loaded: true, execution: 'dormant' });
    model.start(active);
    expect(persisted.at(-1)).toMatchObject({ goal: { id: 'runtime' } });
    model.stop('paused');
    expect(model.snapshot().execution).toBe('retained');
    model.replaceState(active);
    expect(model.snapshot().goal?.id).toBe('runtime');
    model.load(undefined);
    expect(model.snapshot().goal).toBeUndefined();
    model.load(active);
    expect(model.snapshot().goal?.id).toBe('runtime');
    model.clear();
    expect(model.snapshot()).toMatchObject({ execution: 'dormant' });
    expect(persisted.at(-1)).toEqual({ goal: null });
    const unloaded = new GoalRuntimeModel({ persist: () => undefined }, false);
    expect(unloaded.snapshot().loaded).toBe(false);
    expect(unloaded.stop('paused').goal).toBeUndefined();
  });
});

describe('history service delegation', () => {
  it('delegates list/archive/remove and rejects missing restart entries', async () => {
    const list = vi.fn<() => Promise<GoalHistoryEntry[]>>(async () => [
      {
        id: 'h',
        objective: 'history',
        status: 'complete' as const,
        archivedAt: new Date().toISOString(),
        budget: 10,
      },
    ]);
    const store: Pick<GoalHistoryPort, 'list' | 'archive' | 'remove'> = {
      list,
      archive: vi.fn(async (value: GoalHistoryEntry) => value),
      remove: vi.fn(async () => undefined),
    };
    const service = new GoalHistoryService(store);
    await expect(service.list()).resolves.toHaveLength(1);
    await expect(
      service.archive({ id: 'n', objective: 'new', status: 'paused', archivedAt: new Date().toISOString() }),
    ).resolves.toMatchObject({ id: 'n' });
    await expect(service.remove('n')).resolves.toBeUndefined();
    await expect(service.restart('h')).resolves.toMatchObject({ historyId: 'h', objective: 'history', budget: 10 });
    list.mockResolvedValue([
      {
        id: 'without-budget',
        objective: 'history without budget',
        status: 'complete' as const,
        archivedAt: new Date().toISOString(),
      },
    ]);
    await expect(service.restart('without-budget')).resolves.not.toHaveProperty('budget');
    list.mockResolvedValue([]);
    await expect(service.restart('missing')).rejects.toThrow('not found');
  });
});

describe('command registration branches', () => {
  it('notifies UI callers and stays quiet for headless callers', async () => {
    const registrations: Array<{
      handler: (
        args: string,
        ctx: { hasUI: boolean; ui: { notify: (message: string, level: string) => void } },
      ) => Promise<void>;
    }> = [];
    registerGoalCommand(
      { registerCommand: (_name, definition) => registrations.push(definition as (typeof registrations)[number]) },
      { execute: async () => ({ message: 'goal result', level: 'info' as const }) },
    );
    const notify = vi.fn();
    const handler = registrations[0]?.handler;
    expect(handler).toBeDefined();
    await handler?.('', { hasUI: true, ui: { notify } });
    await handler?.('', { hasUI: false, ui: { notify } });
    expect(notify).toHaveBeenCalledOnce();
  });
});
