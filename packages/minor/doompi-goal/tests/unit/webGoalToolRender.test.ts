import { describe, expect, it } from 'vitest';
import { GOAL_TOOL_NAMES, goalCallSummary, goalResultLines } from '../../web/goalToolRender.ts';

const text = (value: string, details?: unknown) => ({ content: [{ type: 'text', text: value }], details });
const done = { expanded: false, isError: false, isPartial: false };
const expanded = { ...done, expanded: true };
const texts = (lines: Array<{ text: string }>) => lines.map((entry) => entry.text);

describe('goal tool call summaries', () => {
  it('previews the summary or the reason with its recurrence', () => {
    expect(GOAL_TOOL_NAMES).toEqual(['goal_complete', 'goal_blocked']);
    expect(goalCallSummary('goal_complete', { goal_id: 'g1', summary: 'all\ntests pass' })).toEqual({
      action: 'complete',
      detail: 'all tests pass',
      metadata: [],
    });
    expect(goalCallSummary('goal_complete', {})).toEqual({ action: 'complete', metadata: [] });
    expect(goalCallSummary('goal_complete', { summary: 'x'.repeat(80) }).detail).toBe(`${'x'.repeat(69)}…`);
    expect(goalCallSummary('goal_blocked', { reason: 'no network', repeated_turns: 3 })).toEqual({
      action: 'blocked',
      detail: 'no network',
      metadata: ['3 turns'],
    });
    expect(goalCallSummary('goal_blocked', { repeated_turns: 1 })).toEqual({ action: 'blocked', metadata: ['1 turn'] });
    expect(goalCallSummary('goal_blocked', { repeated_turns: 'many' })).toEqual({ action: 'blocked', metadata: [] });
  });
});

describe('goal tool result lines', () => {
  it('reports the manager outcome and marks refusals', () => {
    expect(texts(goalResultLines('goal_complete', {}, text('Goal complete: ship it'), done))).toEqual([
      '✓ Goal complete: ship it',
    ]);
    expect(goalResultLines('goal_complete', {}, text('Goal complete: ship it'), done)[0]?.tone).toBe('success');
    expect(texts(goalResultLines('goal_complete', {}, null, done))).toEqual(['✓ goal complete']);
    expect(texts(goalResultLines('goal_blocked', {}, null, done))).toEqual(['✓ goal blocked']);
    expect(
      texts(goalResultLines('goal_complete', {}, text('Goal completion rejected.', { error: true }), done)),
    ).toEqual(['✗ Goal completion rejected.']);
    expect(texts(goalResultLines('goal_blocked', {}, text('boom'), { ...done, isError: true }))).toEqual(['✗ boom']);
    expect(texts(goalResultLines('goal_blocked', {}, null, { ...done, isError: true }))).toEqual([
      '✗ goal_blocked refused',
    ]);
    expect(texts(goalResultLines('goal_blocked', {}, null, { ...done, isPartial: true }))).toEqual([
      '◐ recording the goal outcome',
    ]);
  });

  it('adds the full summary or evidence once expanded', () => {
    expect(
      texts(goalResultLines('goal_complete', { goal_id: 'g1', summary: 'done' }, text('Goal complete: x'), expanded)),
    ).toEqual(['✓ Goal complete: x', 'goal g1', 'summary done']);
    expect(
      texts(
        goalResultLines(
          'goal_blocked',
          { goal_id: 'g1', reason: 'offline', evidence: 'curl failed twice', repeated_turns: 2 },
          text('Goal blocked: offline'),
          expanded,
        ),
      ),
    ).toEqual(['✓ Goal blocked: offline', 'goal g1', 'reason offline', 'evidence curl failed twice']);
    expect(texts(goalResultLines('goal_blocked', { goal_id: 7 }, null, expanded))).toEqual(['✓ goal blocked']);
  });
});
