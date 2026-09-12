import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hub-channel';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerServerFacet } from '../../../src/extensions/server';

const lifecycleMocks = vi.hoisted(() => {
  const container = {
    bashRunService: { run: vi.fn() },
    paths: { setSessionId: vi.fn() },
    lifeline: { arm: vi.fn(async () => '/tmp/runner-lifeline.sock'), dispose: vi.fn() },
    runnerRegistry: {
      listBySession: vi.fn(async () => [
        {
          id: 'runner-a',
          name: 'server',
          pid: 42,
          command: 'sleep 60',
          cwd: '/repo',
          logPath: '/tmp/server.log',
          interactive: false,
          sessionId: 'session-a',
          startedAt: '2026-08-07T00:00:00.000Z',
          state: 'running',
          promoted: true,
          backend: 'native',
          hostPid: 7,
        },
      ]),
      listAll: vi.fn(async () => []),
      subscribe: vi.fn(() => () => undefined),
      complete: vi.fn(async () => undefined),
      close: vi.fn(),
    },
    launcher: {},
    rmuxBackend: {},
    processControl: {},
    ptyHost: { disposeAll: vi.fn(async () => undefined) },
  };
  return {
    container,
    createContainer: vi.fn(() => container),
    reconcileActiveRunners: vi.fn(async () => ({ reclaimed: [], errors: [] })),
    stopRunnerProcess: vi.fn(async () => true),
  };
});

vi.mock('../../../src/services/runnerDependencies', () => ({
  createRunnerDependencies: lifecycleMocks.createContainer,
}));
vi.mock('../../../src/services/reconcile', () => ({
  reconcileActiveRunners: lifecycleMocks.reconcileActiveRunners,
  stopRunnerProcess: lifecycleMocks.stopRunnerProcess,
}));

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope'], directEvents?: DoomDirectEventBus) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: {
      locality: 'local',
      ...(directEvents === undefined ? {} : { directEvents }),
    } as unknown as DoomServerHostService['context'],
    registerApi(api) {
      registered.push(api);
      return {
        dispose() {
          state.disposed += 1;
        },
      };
    },
    registerMethod() {
      return { dispose() {} };
    },
    registerChannel() {
      return { dispose: () => undefined };
    },
    mounted() {
      return registered.map((api) => api.basePath);
    },
    mountedChannels() {
      return [];
    },
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, registered, state };
}

function headlessFacetContext() {
  const directEvents: DoomDirectEventBus = {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
  const server = hostContext('session', directEvents);
  const execution = {
    cwd: '/repo',
    sessionId: 'session-a',
    selection: { majorMode: 'copilot', activeLayers: ['runner'], domains: [], minorModes: [] },
    client: { notify: vi.fn(), request: vi.fn(async () => undefined), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(async () => undefined),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
      activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    },
    shutdown: vi.fn(),
  } as unknown as DoomHeadlessExecutionContext;
  let activity: DoomHeadlessActivity | undefined;
  const headless = {
    context: execution,
    select: vi.fn(async () => undefined),
    registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    registerActivity: vi.fn((candidate: DoomHeadlessActivity) => {
      activity = candidate;
      return { dispose: vi.fn() };
    }),
  } as unknown as DoomHeadlessHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, server.context.get(DOOM_SERVER_HOST_SERVICE));
  context.provide(DOOM_HEADLESS_HOST_SERVICE, headless);
  return {
    context,
    execution,
    activity: () => {
      if (activity === undefined) throw new Error('runner activity was not registered');
      return activity;
    },
    directEvents,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('runnerServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', async () => {
    expect(runnerServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the package API on the session scope', async () => {
    const harness = hostContext('session');

    const dispose = await runnerServerFacet.apply(harness.context);

    expect(harness.registered).toHaveLength(1);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when the host disposes the facet', async () => {
    const harness = hostContext('session');

    await (
      await runnerServerFacet.apply(harness.context)
    )?.();

    expect(harness.state.disposed).toBe(1);
  });

  it('registers nothing on the other scope', async () => {
    const harness = hostContext('global');

    const dispose = await runnerServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([]);
    expect(typeof dispose).toBe('function');
  });

  it('retains runner ownership across activation changes and cleans it on session disposal', async () => {
    const harness = headlessFacetContext();
    const dispose = await runnerServerFacet.apply(harness.context);
    const activity = harness.activity();

    const firstStop = await activity.start(harness.execution);
    await vi.waitFor(() =>
      expect(harness.directEvents.publish).toHaveBeenCalledWith('runner_runs', 'session-a', { runs: [] }),
    );
    expect(lifecycleMocks.container.paths.setSessionId).toHaveBeenCalledWith('session-a');
    expect(lifecycleMocks.container.paths.setSessionId.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycleMocks.container.lifeline.arm.mock.invocationCallOrder[0]!,
    );
    await firstStop();

    expect(lifecycleMocks.stopRunnerProcess).not.toHaveBeenCalled();
    expect(lifecycleMocks.container.ptyHost.disposeAll).not.toHaveBeenCalled();
    expect(lifecycleMocks.container.lifeline.dispose).not.toHaveBeenCalled();
    expect(lifecycleMocks.container.runnerRegistry.close).not.toHaveBeenCalled();

    const secondStop = await activity.start(harness.execution);
    expect(lifecycleMocks.createContainer).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.lifeline.arm).toHaveBeenCalledTimes(2);
    await secondStop();

    await (dispose as () => void | Promise<void>)();

    expect(lifecycleMocks.stopRunnerProcess).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.runnerRegistry.complete).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.ptyHost.disposeAll).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.lifeline.dispose).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.runnerRegistry.close).toHaveBeenCalledOnce();
  });
});
