import { describe, expect, it, vi } from 'vitest';

import { stepStopGate } from '../../../src/services/stepStopGate';

const gate = vi.hoisted(() => vi.fn(async () => ({ action: 'block', message: 'Record the outcome.' })));
vi.mock('@agimon-ai/workflow-mcp', async (original) => ({
  ...(await original<typeof import('@agimon-ai/workflow-mcp')>()),
  gateStepDecision: gate,
}));

const environment = { WORKFLOW_DECISION_FILE: '/run/decision.json' };

describe('stepStopGate', () => {
  it('ignores ordinary sessions, host steering and subagents', async () => {
    gate.mockClear();
    for (const env of [
      {},
      { ...environment, WORKFLOW_DECISION_STEERING: 'host' },
      { ...environment, PI_SUBAGENT_CHILD: '1' },
    ])
      expect(await stepStopGate(env, undefined)).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
  });

  it('preserves missing pane coordinator fallback and excludes workflow monitoring', async () => {
    gate.mockClear();
    expect(await stepStopGate(environment, undefined)).toBe('Record the outcome.');
    expect(
      await stepStopGate(environment, {
        items: [{ provider: 'workflow-mcp', id: 'run', sessionId: 'step' }],
        errors: [],
      }),
    ).toBe('Record the outcome.');
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('does not consult the mutating gate while owned background work or provider errors block', async () => {
    gate.mockClear();
    expect(
      await stepStopGate(environment, {
        items: [{ provider: 'team-direct-runs', id: 'child', sessionId: 'step', status: 'completed' }],
        errors: [],
      }),
    ).toBeUndefined();
    expect(
      await stepStopGate(environment, { items: [], errors: [{ provider: 'doom-runner', message: 'unknown' }] }),
    ).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
    expect(await stepStopGate(environment, { items: [], errors: [] })).toBe('Record the outcome.');
    expect(gate).toHaveBeenCalledOnce();
  });
});
