import type {
  MinorModeCatalogService,
  MinorModeOwnerDefinition,
  MinorModeOwnerHandle,
  MinorModeState,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { GoalPiManager, GoalStateEvent } from '../../src/adapters/pi/goalManager.ts';
import { goalMinorModeState, registerGoalMinorMode } from '../../src/adapters/pi/runtimeActivation.ts';

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

interface ModeFixture {
  readonly catalog: MinorModeCatalogService;
  readonly disposeOwner: ReturnType<typeof vi.fn>;
  readonly disposeState: ReturnType<typeof vi.fn>;
  readonly manager: GoalPiManager;
  readonly publish: ReturnType<typeof vi.fn>;
  definition(): MinorModeOwnerDefinition<ExtensionContext>;
  emit(event: GoalStateEvent): void;
}

function modeFixture(): ModeFixture {
  let definition: MinorModeOwnerDefinition<ExtensionContext> | undefined;
  let stateListener: ((event: GoalStateEvent) => void) | undefined;
  const publish = vi.fn();
  const disposeOwner = vi.fn();
  const disposeState = vi.fn();
  const owner: MinorModeOwnerHandle = {
    getState: () => definition?.initialState ?? goalMinorModeState(undefined),
    publish,
    dispose: disposeOwner,
  };
  const catalog = {
    registerOwner: vi.fn((next: MinorModeOwnerDefinition<ExtensionContext>) => {
      definition = next;
      return owner;
    }),
  } as unknown as MinorModeCatalogService;
  const manager = {
    snapshot: vi.fn(() => ({ goal: { id: 'goal-initial', status: 'paused' } })),
    subscribeState: vi.fn((listener: (event: GoalStateEvent) => void) => {
      stateListener = listener;
      return disposeState;
    }),
    startFromCatalog: vi.fn(async () => undefined),
    endFromLeader: vi.fn(async () => undefined),
  } as unknown as GoalPiManager;

  return {
    catalog,
    disposeOwner,
    disposeState,
    manager,
    publish,
    definition() {
      if (!definition) throw new Error('Expected Goal to register its minor mode.');
      return definition;
    },
    emit(event) {
      if (!stateListener) throw new Error('Expected Goal to subscribe to state changes.');
      stateListener(event);
    },
  };
}

describe('Goal minor-mode registration', () => {
  it('registers, publishes state, routes actions, and releases both bindings', async () => {
    const fixture = modeFixture();
    const dispose = registerGoalMinorMode(fixture.catalog, fixture.manager);
    const definition = fixture.definition();
    const context = { cwd: '/repo', mode: 'print' } as unknown as ExtensionContext;
    const execution = {
      context,
      operationId: 'goal-mode-operation',
      sessionKind: 'headless' as const,
      signal: new AbortController().signal,
    };

    expect(definition.descriptor).toMatchObject({
      source: '@agimon-ai/doompi-goal',
      id: 'goal',
      label: 'Goal',
      order: 100,
    });
    expect(definition.initialState).toEqual(goalMinorModeState('paused', 'goal-initial'));

    fixture.emit({ goalId: 'goal-1', status: 'blocked' });
    expect(fixture.publish).toHaveBeenCalledWith(goalMinorModeState('blocked', 'goal-1'));

    await expect(definition.handleAction('start', { objective: 'Ship it', budget: 1200 }, execution)).resolves.toEqual({
      message: 'Goal started.',
    });
    expect(fixture.manager.startFromCatalog).toHaveBeenCalledWith('Ship it', 1200, context);

    await expect(definition.handleAction('end', {}, execution)).resolves.toEqual({ message: 'Goal ended.' });
    expect(fixture.manager.endFromLeader).toHaveBeenCalledWith(context);
    await expect(definition.handleAction('unknown', {}, execution)).rejects.toThrow(
      'Unknown goal mode action: unknown',
    );

    dispose();
    expect(fixture.disposeState).toHaveBeenCalledOnce();
    expect(fixture.disposeOwner).toHaveBeenCalledOnce();
  });

  it('still disposes the owner when state unsubscription fails', () => {
    const fixture = modeFixture();
    const failure = new Error('state disposal failed');
    fixture.disposeState.mockImplementationOnce(() => {
      throw failure;
    });
    const dispose = registerGoalMinorMode(fixture.catalog, fixture.manager);

    expect(dispose).toThrow(failure);
    expect(fixture.disposeOwner).toHaveBeenCalledOnce();
  });

  it('aggregates failures from both disposal paths', () => {
    const fixture = modeFixture();
    fixture.disposeState.mockImplementationOnce(() => {
      throw new Error('state disposal failed');
    });
    fixture.disposeOwner.mockImplementationOnce(() => {
      throw new Error('owner disposal failed');
    });
    const dispose = registerGoalMinorMode(fixture.catalog, fixture.manager);

    expect(dispose).toThrow(AggregateError);
  });
});
