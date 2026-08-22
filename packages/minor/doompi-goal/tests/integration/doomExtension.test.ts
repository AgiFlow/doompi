import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activateGoalRuntime: vi.fn(),
  runtimeDispose: vi.fn(),
  leaderUpdate: vi.fn(),
  leaderDispose: vi.fn(),
  actionDispose: vi.fn(),
  createCordisRoot: vi.fn(),
  leader: vi.fn(),
  actions: vi.fn(),
  prepareCordisRoot: vi.fn(),
  stateDispose: vi.fn(),
}));

const cordisRoots: Context[] = [];

vi.mock('../../src/adapters/pi/runtimeActivation.ts', () => ({
  activateGoalRuntime: mocks.activateGoalRuntime,
  isRetainedGoalStatus: (status: unknown) =>
    typeof status === 'string' && status !== 'cleared' && status !== 'complete',
}));
vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => {
    const root = mocks.createCordisRoot() as Context;
    await mocks.prepareCordisRoot(root);
    return {
      root,
      runtime: { abiVersion: 1, generation: 'goal-test', hostId: 'goal-test', mode: 'composed' },
      dispose: async () => undefined,
    };
  },
}));
vi.mock('../../src/tui/goalHistoryOverlay.ts', () => ({
  openGoalHistoryOverlay: vi.fn(),
}));

import { registerGoalExtension } from '../../src/adapters/pi/extension';

interface Fixture {
  pi: ExtensionAPI;
  listeners: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  emitState: (status: string) => void;
  manager: {
    snapshot: () => { goal?: { status: string } };
    showFromLeader: ReturnType<typeof vi.fn>;
    startFromLeader: ReturnType<typeof vi.fn>;
    startFromCatalog: ReturnType<typeof vi.fn>;
    endFromLeader: ReturnType<typeof vi.fn>;
    listHistory: ReturnType<typeof vi.fn>;
    subscribeState: ReturnType<typeof vi.fn>;
  };
}

function createFixture(): Fixture {
  const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let stateListener: ((event: { status: string }) => void) | undefined;
  const manager = {
    snapshot: vi.fn(() => ({ goal: undefined })),
    showFromLeader: vi.fn(),
    startFromLeader: vi.fn(),
    startFromCatalog: vi.fn(),
    endFromLeader: vi.fn(),
    listHistory: vi.fn(),
    subscribeState: vi.fn((listener: (event: { status: string }) => void) => {
      stateListener = listener;
      return mocks.stateDispose;
    }),
  };
  mocks.activateGoalRuntime.mockReturnValue({ manager, dispose: mocks.runtimeDispose });
  const pi = {
    on(event: string, handler: (payload: unknown, ctx: ExtensionContext) => unknown) {
      listeners.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    listeners,
    emitState: (status) => stateListener?.({ status }),
    manager,
  };
}

const context = {
  mode: 'tui',
  hasUI: true,
  ui: { getEditorText: vi.fn(() => ''), setEditorText: vi.fn(), notify: vi.fn() },
  sessionManager: { getSessionId: () => 'goal-session' },
} as unknown as ExtensionContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createCordisRoot.mockImplementation(() => {
    const root = new Context();
    cordisRoots.push(root);
    return root;
  });
  mocks.prepareCordisRoot.mockImplementation(async (root: Context) => {
    const hub = {
      registerConfig: vi.fn(),
      registerFooter: vi.fn(),
      registerLeader: mocks.leader,
      registerLeaderActions: mocks.actions,
    } as unknown as DoomUiHubService;
    await root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, hub));
  });
  mocks.leader.mockReturnValue({ update: mocks.leaderUpdate, dispose: mocks.leaderDispose });
  mocks.actions.mockReturnValue(mocks.actionDispose);
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
});

describe('standard Goal entrypoint', () => {
  // With no goal held, `e` starts one and neither ending nor showing a goal is
  // reachable: both would be actions with nothing to act on.
  it('keeps the current-goal and end actions out of the dormant action tree', async () => {
    const fixture = createFixture();
    await registerGoalExtension(fixture.pi);

    expect(mocks.leader).toHaveBeenCalledWith(
      expect.objectContaining({
        source: '@agimon-ai/doompi-goal',
        bindings: expect.arrayContaining([
          expect.objectContaining({ id: 'goal.start', action: { name: 'goal.start' } }),
          expect.objectContaining({ id: 'goal.history', action: { name: 'goal.history' } }),
        ]),
      }),
    );
    const contribution = mocks.leader.mock.calls.at(-1)?.[0] as {
      bindings: Array<{ id: string; path: Array<{ key: string; label: string }> }>;
    };
    const ids = contribution.bindings.map((binding) => binding.id);
    expect(ids).not.toContain('goal.show');
    expect(ids).not.toContain('goal.end');
    expect(contribution.bindings.find((binding) => binding.id === 'goal.start')?.path[1]).toMatchObject({
      key: 'e',
      label: 'enter',
    });
    expect(mocks.actions).toHaveBeenCalledOnce();
  });

  it('publishes retained state and awaits idempotent shutdown before recreation', async () => {
    const fixture = createFixture();
    await registerGoalExtension(fixture.pi);
    fixture.emitState('active');
    const group = { key: 'g', label: 'goal', detail: 'session objective', order: 100 };
    expect(mocks.leaderUpdate).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'goal.show',
          path: [group, { key: 'g', label: 'current', detail: 'the goal being worked' }],
        }),
        // `e` now leaves the goal it entered, and its tone paints the badge apart.
        expect.objectContaining({
          id: 'goal.end',
          path: [group, { key: 'e', label: 'exit', detail: 'end the current goal', tone: 'exit' }],
        }),
      ]),
    );
    fixture.emitState('cleared');
    const dormantBindings = mocks.leaderUpdate.mock.calls.at(-1)?.[0] as Array<{ id: string }>;
    expect(dormantBindings.map((binding) => binding.id)).not.toContain('goal.show');
    expect(dormantBindings.map((binding) => binding.id)).toContain('goal.start');

    await fixture.listeners.get('session_shutdown')?.({}, context);
    await fixture.listeners.get('session_shutdown')?.({}, context);
    expect(mocks.actionDispose).toHaveBeenCalledOnce();
    expect(mocks.leaderDispose).toHaveBeenCalledOnce();
    expect(mocks.runtimeDispose).toHaveBeenCalledOnce();

    await registerGoalExtension(fixture.pi);
    expect(mocks.activateGoalRuntime).toHaveBeenCalledTimes(2);
  });
});
