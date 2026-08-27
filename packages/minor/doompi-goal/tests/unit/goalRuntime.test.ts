import { describe, expect, it } from 'vitest';
import {
  assistantUsageTokens,
  cumulativeAssistantTokens,
  formatDuration,
  formatTokenCount,
} from '../../src/services/accounting.ts';
import { parseGoalCommand, parseTokenBudget, validateObjective } from '../../src/services/parser.ts';
import { buildGoalPrompt, buildGoalSystemPrompt } from '../../src/services/prompts.ts';
import { nextToolFreeRepeatState, resetGoalSafetyEpoch, safetyLimitReached } from '../../src/services/safety.ts';
import { normalizeGoalSettings } from '../../src/services/settings.ts';
import { decodeGoalStateEntries, serializeGoalState } from '../../src/services/stateCodec.ts';
import {
  createGoal,
  getExecutionState,
  isContradictoryCompletionSummary,
  transitionGoal,
} from '../../src/services/stateMachine.ts';
import {
  addGoalTools,
  filterGoalTools,
  goalToolNamesForState,
  validateBlockedInput,
  validateCompletionInput,
} from '../../src/services/tools.ts';

describe('goal parser and accounting', () => {
  it('parses budgets, quoted objectives, aliases, and validation', () => {
    expect(parseTokenBudget('1.5k')).toBe(1500);
    expect(parseTokenBudget('bad')).toBeUndefined();
    expect(parseGoalCommand('--tokens 2m "ship it"')).toMatchObject({
      kind: 'start',
      objective: 'ship it',
      tokenBudget: 2_000_000,
    });
    expect(parseGoalCommand('status')).toEqual({ kind: 'show' });
    expect(validateObjective('')).toContain('Usage');
    expect(validateObjective('ok')).toBeUndefined();
  });
  it('formats and totals usage safely', () => {
    expect(assistantUsageTokens({ input: 2, output: 3 })).toBe(5);
    expect(
      cumulativeAssistantTokens([{ type: 'message', message: { role: 'assistant', usage: { totalTokens: 7 } } }]),
    ).toBe(7);
    expect(formatDuration(3661)).toBe('1h1m');
    expect(formatTokenCount(1500)).toBe('1.5k');
  });
});

describe('goal codec and state machine', () => {
  it('fails closed on malformed newest canonical state and respects a clear barrier', () => {
    const goal = createGoal('test', undefined, { id: 'g1', now: 10 });
    expect(
      decodeGoalStateEntries([{ type: 'custom', customType: 'goal-state', data: serializeGoalState(goal) }]).goal?.id,
    ).toBe('g1');
    expect(decodeGoalStateEntries([{ type: 'custom', customType: 'goal-state', data: { goal: null } }])).toMatchObject({
      goal: undefined,
      malformed: false,
    });
    expect(
      decodeGoalStateEntries([
        { type: 'custom', customType: 'goal-state', data: serializeGoalState(goal) },
        { type: 'custom', customType: 'goal-state', data: { goal: 'bad' } },
      ]),
    ).toMatchObject({ goal: undefined, malformed: true });
  });
  it('separates dormant, retained, and executing states', () => {
    const goal = createGoal('test', 10, { id: 'g1', now: 10 });
    expect(getExecutionState({ goal: undefined })).toBe('dormant');
    expect(getExecutionState({ goal: transitionGoal(goal, 'paused', 20) })).toBe('retained');
    expect(getExecutionState({ goal })).toBe('executing');
    expect(isContradictoryCompletionSummary('tests still fail')).toBe(true);
  });
});

describe('prompts settings safety and tools', () => {
  it('escapes objective data and keeps tool visibility operational-only', () => {
    const goal = createGoal('<task>', undefined, { id: 'g1', now: 10 });
    const prompt = buildGoalPrompt(goal);
    expect(prompt).toBe('[goal]\n<task>');
    expect(prompt).not.toContain('<goal_id>');
    expect(buildGoalSystemPrompt(goal)).toContain('<goal_id>');
    expect(buildGoalSystemPrompt(goal)).toContain('&lt;task&gt;');
    expect(normalizeGoalSettings({ toolVisibility: 'always' })?.toolVisibility).toBe('operational');
    expect(normalizeGoalSettings({ toolVisibility: 'after-first-goal' })?.toolVisibility).toBe('operational');
    expect(normalizeGoalSettings({ toolVisibility: 'bad' })).toBeUndefined();
  });
  it('enforces safety and strict tool inputs', () => {
    const goal = createGoal('test', undefined, { id: 'g1', now: 10 });
    const repeated = nextToolFreeRepeatState(
      {
        toolFreeRepeatCount: 1,
        lastToolFreeOutputFingerprint: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      [{ role: 'assistant', text: 'same' }],
      false,
    );
    expect(repeated.toolFreeRepeatCount).toBe(1);
    expect(
      safetyLimitReached({ automaticModelTurns: 3, toolFreeRepeatCount: 0 }, { automaticTurns: 3, noProgressTurns: 3 }),
    ).toBe('continuation_limit');
    expect(resetGoalSafetyEpoch({ ...goal, automaticModelTurns: 3 }, 20).automaticModelTurns).toBe(0);
    expect(goalToolNamesForState(goal)).toEqual(['goal_complete', 'goal_blocked']);
    expect(goalToolNamesForState(transitionGoal(goal, 'budget_limited', 20))).toEqual(['goal_complete']);
    expect(filterGoalTools(['read', 'goal_complete'])).toEqual(['read']);
    expect(addGoalTools(['read'], 'active')).toEqual(['read', 'goal_complete', 'goal_blocked']);
    expect(validateCompletionInput(goal, { goal_id: 'g1', summary: 'done' }).ok).toBe(true);
    expect(
      validateBlockedInput(goal, { goal_id: 'g1', reason: 'blocked', evidence: 'proof', repeated_turns: 3 }).ok,
    ).toBe(true);
  });
});
