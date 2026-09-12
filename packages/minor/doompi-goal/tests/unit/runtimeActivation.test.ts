import type { MinorModeState } from '@agimon-ai/doompi-minor-mode';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { GoalPiManager } from '../../src/controllers/goalManager';
import { goalMinorModeState, createGoalMinorMode } from '../../src/controllers/runtimeActivation';

function expectedActions(active: boolean): MinorModeState['actions'] {
  return active
    ? [
        { id: 'start', enabled: false, disabledReason: 'A goal is already active.' },
        { id: 'end', enabled: true },
      ]
    : [
        { id: 'start', enabled: true },
        { id: 'end', enabled: false, disabledReason: 'No goal is active.' },
      ];
}

describe('Goal minor-mode state', () => {
  it.each([
    { status: undefined, activation: 'inactive', condition: 'ready' },
    { status: 'cleared', activation: 'inactive', condition: 'ready' },
    { status: 'complete', activation: 'inactive', condition: 'ready' },
  ] as const)('maps $status to an inactive mode', ({ status, activation, condition }) => {
    expect(goalMinorModeState(status)).toEqual({
      activation,
      condition,
      actions: expectedActions(false),
    });
  });

  it.each([
    { status: 'active', condition: 'ready', detail: 'active', color: 'accent' },
    { status: 'paused', condition: 'paused', detail: 'paused', color: 'warning' },
    { status: 'blocked', condition: 'blocked', detail: 'blocked', color: 'warning' },
    { status: 'usage_limited', condition: 'limited', detail: 'usage limited', color: 'warning' },
    { status: 'budget_limited', condition: 'limited', detail: 'budget limited', color: 'warning' },
    { status: 'future-status', condition: 'ready', detail: 'future-status', color: 'warning' },
  ] as const)('maps $status to an active mode', ({ status, condition, detail, color }) => {
    expect(goalMinorModeState(status, 'goal-stable-1')).toEqual({
      activation: 'active',
      condition,
      detail,
      color,
      modelContextVariant: 'goal-stable-1',
      actions: expectedActions(true),
    });
  });
});

it('creates a Goal mode owner that publishes state and preserves action execution context', async () => {
  let status = 'paused';
  const manager = {
    snapshot: () => ({ goal: { status, id: 'goal-initial' } }),
    startFromCatalog: vi.fn(async () => undefined),
    endFromLeader: vi.fn(async () => undefined),
  } as unknown as GoalPiManager;
  const owner = createGoalMinorMode(manager);
  const publish = vi.fn();
  owner.attach({ getState: () => owner.state(), publish, dispose: vi.fn() });
  expect(owner.definition.initialState).toEqual(goalMinorModeState('paused', 'goal-initial'));
  status = 'blocked';
  owner.publish();
  expect(publish).toHaveBeenCalledWith(goalMinorModeState('blocked', 'goal-initial'));
  const context = { cwd: '/repo', mode: 'print' } as unknown as ExtensionContext;
  const execution = {
    context,
    operationId: 'operation',
    sessionKind: 'headless' as const,
    signal: new AbortController().signal,
  };
  await expect(
    owner.definition.handleAction('start', { objective: 'Ship it', budget: 1200 }, execution),
  ).resolves.toEqual({ message: 'Goal started.' });
  expect(manager.startFromCatalog).toHaveBeenCalledWith('Ship it', 1200, context);
  await expect(owner.definition.handleAction('end', {}, execution)).resolves.toEqual({ message: 'Goal ended.' });
  expect(manager.endFromLeader).toHaveBeenCalledWith(context);
  await expect(owner.definition.handleAction('unknown', {}, execution)).rejects.toThrow('Unknown goal mode action');
  owner.detach();
});
