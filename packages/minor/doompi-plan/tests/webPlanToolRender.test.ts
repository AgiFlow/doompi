import { describe, expect, it } from 'vitest';
import { PLAN_TOOL_NAMES, planCallSummary, planResultLines } from '../web/planToolRender.ts';

const text = (value: string, details?: unknown) => ({ content: [{ type: 'text', text: value }], details });
const done = { expanded: false, isError: false, isPartial: false };
const expanded = { ...done, expanded: true };
const partial = { ...done, isPartial: true };
const texts = (lines: Array<{ text: string }>) => lines.map((entry) => entry.text);

describe('plan tool call summaries', () => {
  it('names each tool by purpose and counts what the packet carries', () => {
    expect(PLAN_TOOL_NAMES).toEqual(['record_debug_evidence', 'run_fable_plan', 'write_plan', 'complete_plan']);
    expect(
      planCallSummary('record_debug_evidence', {
        issue: 'tests\tflake',
        logs: ['a', 'b'],
        hypotheses: ['h'],
        unavailableEvidence: [],
      }),
    ).toEqual({ action: 'record evidence', detail: 'tests flake', metadata: ['2 logs', '1 hypothesis'] });
    expect(planCallSummary('record_debug_evidence', { issue: 'x'.repeat(80) }).detail).toBe(`${'x'.repeat(69)}…`);
    expect(planCallSummary('record_debug_evidence', {})).toEqual({ action: 'record evidence', metadata: [] });
    expect(
      planCallSummary('run_fable_plan', {
        goal: ['g'],
        constraints: ['a', 'b'],
        unresolvedQuestions: ['q'],
        currentPlan: 'p',
      }),
    ).toEqual({ action: 'fable draft', metadata: ['1 goal', '2 constraints', '1 open question', 'with current plan'] });
    expect(planCallSummary('write_plan', {})).toEqual({ action: 'save plan', metadata: [] });
    expect(planCallSummary('complete_plan', {})).toEqual({ action: 'request approval', metadata: [] });
    expect(planCallSummary('complete_plan', { decision: 'exit' })).toEqual({ action: 'decide exit', metadata: [] });
  });
});

describe('plan tool result lines', () => {
  it('reports a failure with the tool text', () => {
    expect(texts(planResultLines('write_plan', {}, text('boom'), { ...done, isError: true }))).toEqual(['✗ boom']);
    expect(texts(planResultLines('write_plan', {}, null, { ...done, isError: true }))).toEqual(['✗ write_plan failed']);
  });

  it('confirms recorded evidence and lists it once expanded', () => {
    const args = {
      issue: 'flaky',
      expectedBehavior: 'pass',
      actualBehavior: 'fail',
      logs: ['log 1', 'log 2'],
      hypotheses: ['race', 7],
    };
    expect(texts(planResultLines('record_debug_evidence', args, text('ok', { recorded: true }), done))).toEqual([
      '✓ evidence recorded as planning context',
    ]);
    expect(texts(planResultLines('record_debug_evidence', args, text('ok', { recorded: true }), expanded))).toEqual([
      '✓ evidence recorded as planning context',
      'issue flaky',
      'expected pass',
      'actual fail',
      'logs',
      'log 1',
      'log 2',
      'hypothesis',
      'race',
    ]);
    expect(
      texts(
        planResultLines('record_debug_evidence', {}, text('Debug planning is not active.', { recorded: false }), done),
      ),
    ).toEqual(['○ Debug planning is not active.']);
    expect(texts(planResultLines('record_debug_evidence', {}, null, done))).toEqual(['○ not recorded']);
  });

  it('shows the fable draft collapsed until expanded, and why it did not run', () => {
    const draft = Array.from({ length: 15 }, (_, index) => `step ${index}`).join('\n');
    const ok = text(`Fable draft:\n${draft}`, { started: true, status: 'completed', draft });
    const collapsed = texts(planResultLines('run_fable_plan', {}, ok, done));
    expect(collapsed[0]).toBe('✓ fable draft · completed');
    expect(collapsed).toHaveLength(14);
    expect(collapsed.at(-1)).toBe('… 3 more lines');
    expect(texts(planResultLines('run_fable_plan', {}, ok, expanded))).toHaveLength(16);
    expect(
      texts(
        planResultLines(
          'run_fable_plan',
          {},
          text('', { started: true, status: 'review', draft: 'd', errorCode: 'x' }),
          done,
        ),
      ),
    ).toEqual(['! fable draft · review · x', 'd']);
    expect(
      texts(
        planResultLines(
          'run_fable_plan',
          {},
          text('', { started: true, status: 'failed', errorCode: 'timeout' }),
          done,
        ),
      ),
    ).toEqual(['✗ fable planning failed · timeout']);
    expect(texts(planResultLines('run_fable_plan', {}, text('', { started: true }), done))).toEqual([
      '✗ fable planning unknown',
    ]);
    expect(
      texts(
        planResultLines(
          'run_fable_plan',
          {},
          text('The local Fable broker is unavailable.', { started: false, errorCode: 'broker_unavailable' }),
          done,
        ),
      ),
    ).toEqual(['○ The local Fable broker is unavailable. · broker_unavailable']);
    expect(texts(planResultLines('run_fable_plan', {}, null, done))).toEqual(['○ fable planning did not start']);
    expect(texts(planResultLines('run_fable_plan', {}, null, partial))).toEqual([
      '◐ drafting with the local Fable broker',
    ]);
  });

  it('tracks a plan write through its phases', () => {
    expect(
      texts(
        planResultLines('write_plan', {}, text('Checking /p/a.md...', { phase: 'checking', path: '/p/a.md' }), partial),
      ),
    ).toEqual(['◐ checking /p/a.md']);
    expect(texts(planResultLines('write_plan', {}, null, partial))).toEqual(['◐ checking']);
    expect(
      texts(
        planResultLines(
          'write_plan',
          {},
          text('Wrote plan.', { written: true, path: '/p/a.md', durationMs: 12 }),
          done,
        ),
      ),
    ).toEqual(['✓ wrote /p/a.md · 12ms']);
    expect(texts(planResultLines('write_plan', {}, text('', { written: true }), done))).toEqual(['✓ wrote the plan']);
    expect(
      texts(
        planResultLines('write_plan', {}, text('Plan mode is disabled.', { written: false, path: '/p/a.md' }), done),
      ),
    ).toEqual(['○ Plan mode is disabled.', 'path /p/a.md']);
    expect(texts(planResultLines('write_plan', {}, null, done))).toEqual(['○ plan not written']);
  });

  it('reports the review decision', () => {
    expect(texts(planResultLines('complete_plan', {}, text('Exited plan mode.', { exited: true }), done))).toEqual([
      '✓ plan mode exited · Exited plan mode.',
    ]);
    expect(texts(planResultLines('complete_plan', {}, text('', { exited: true }), done))).toEqual([
      '✓ plan mode exited',
    ]);
    expect(
      texts(planResultLines('complete_plan', {}, text('Present the plan first.', { exited: false }), done)),
    ).toEqual(['○ staying in plan mode · Present the plan first.']);
    expect(texts(planResultLines('complete_plan', {}, null, done))).toEqual(['○ staying in plan mode']);
    expect(texts(planResultLines('complete_plan', {}, null, partial))).toEqual(['◐ waiting for the review decision']);
  });
});
