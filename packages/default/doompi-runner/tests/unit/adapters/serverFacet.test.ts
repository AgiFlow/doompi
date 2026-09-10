import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerServerFacet } from '../../../src/exports/extensions/server.ts';

const lifecycleMocks = vi.hoisted(() => {
  const container = {
    bashRunService: { run: vi.fn() },
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

vi.mock('../../../src/container/index.ts', () => ({
  createRunnerContainer: lifecycleMocks.createContainer,
}));
vi.mock('../../../src/services/runs/reconcile.ts', () => ({
  reconcileActiveRunners: lifecycleMocks.reconcileActiveRunners,
  stopRunnerProcess: lifecycleMocks.stopRunnerProcess,
}));

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(api) {
      registered.push(api);
      return {
        dispose() {
          state.disposed += 1;
        },
      };
    },
    mounted() {
      return registered.map((api) => api.basePath);
    },
  };
  const context = {
    get(name: string) {
      return name === DOOM_SERVER_HOST_SERVICE ? host : undefined;
    },
  } as unknown as Context;
  return { context, registered, state };
}

function headlessFacetContext() {
  const server = hostContext('session');
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
  const context = {
    get(name: string) {
      if (name === DOOM_SERVER_HOST_SERVICE) return server.context.get(name);
      if (name === DOOM_HEADLESS_HOST_SERVICE) return headless;
      return undefined;
    },
  } as unknown as Context;
  return {
    context,
    execution,
    activity: () => {
      if (activity === undefined) throw new Error('runner activity was not registered');
      return activity;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('runnerServerFacet', () => {
  it('injects the server host so the facet mounts as one fiber', () => {
    expect(runnerServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the package API on the session scope', () => {
    const harness = hostContext('session');

    const dispose = runnerServerFacet.apply(harness.context);

    expect(harness.registered).toHaveLength(1);
    expect(typeof dispose).toBe('function');
  });

  it('unregisters the API when the host disposes the facet', () => {
    const harness = hostContext('session');

    runnerServerFacet.apply(harness.context)?.();

    expect(harness.state.disposed).toBe(1);
  });

  it('registers nothing on the other scope', () => {
    const harness = hostContext('hub');

    const dispose = runnerServerFacet.apply(harness.context);

    expect(harness.registered).toEqual([]);
    expect(dispose).toBeUndefined();
  });

  it('retains runner ownership across activation changes and cleans it on session disposal', async () => {
    const harness = headlessFacetContext();
    const dispose = runnerServerFacet.apply(harness.context);
    const activity = harness.activity();

    const firstStop = await activity.start(harness.execution);
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
