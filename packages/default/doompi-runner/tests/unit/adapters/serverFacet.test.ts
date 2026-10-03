import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hubChannel';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { Context } from '@deepseek-ai/cordis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { facet as runnerServerFacet } from '../../../generated/server';
import { RUNNER_SERVER_SCOPE_SERVICE } from '../../../src/extensions/workspaces/sessions/(backend)/_lib/serverRoot';

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
      get: vi.fn(async (): Promise<unknown> => undefined),
      subscribe: vi.fn((_listener: () => void, _sessionId: string) => () => undefined),
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

function hostContext(
  scope: DoomServerHostService['scope'],
  directEvents: DoomDirectEventBus = {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    close: vi.fn(),
  },
) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: {
      locality: 'local',
      cwd: '/repo',
      environment: { SESSION_ONLY: 'runner' },
      directEvents,
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
      admitPrompt: vi.fn(async () => undefined),
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
    tool: (name: string) => {
      const registerTool = headless.registerTool as unknown as ReturnType<typeof vi.fn>;
      const found = registerTool.mock.calls.map(([tool]) => tool).find((tool) => tool.name === name);
      if (found === undefined) throw new Error(`${name} tool was not registered`);
      return found as { execute: (...args: unknown[]) => Promise<unknown> };
    },
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

  it('provides the session-owned Bash tool to MCP plugins', async () => {
    const harness = hostContext('session');
    const dispose = await runnerServerFacet.apply(harness.context);

    expect(harness.context.get(RUNNER_SERVER_SCOPE_SERVICE)?.tool).toBeDefined();

    await (dispose as () => void | Promise<void>)?.();
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
    expect(lifecycleMocks.createContainer).toHaveBeenCalledWith({
      cwd: '/repo',
      environment: { SESSION_ONLY: 'runner' },
    });
    expect(lifecycleMocks.container.lifeline.arm).toHaveBeenCalledTimes(2);
    await secondStop();

    await (dispose as () => void | Promise<void>)();

    expect(lifecycleMocks.stopRunnerProcess).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.runnerRegistry.complete).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.ptyHost.disposeAll).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.lifeline.dispose).toHaveBeenCalledOnce();
    expect(lifecycleMocks.container.runnerRegistry.close).toHaveBeenCalledOnce();
  });

  describe('background runner wake-up', () => {
    const runner = {
      id: 'runner-b',
      name: 'build',
      pid: 43,
      command: 'sleep 5',
      cwd: '/repo',
      logPath: '/tmp/build.log',
      interactive: false,
      sessionId: 'session-a',
      startedAt: '2026-08-07T00:00:00.000Z',
      promoted: true,
      backend: 'native',
      hostPid: 7,
    };
    const promote = async () => {
      const harness = headlessFacetContext();
      let notifyRegistry = (): void => undefined;
      lifecycleMocks.container.runnerRegistry.subscribe.mockImplementationOnce((listener) => {
        notifyRegistry = listener;
        return () => undefined;
      });
      lifecycleMocks.container.runnerRegistry.get.mockResolvedValueOnce({ ...runner, state: 'running' });
      lifecycleMocks.container.bashRunService.run.mockResolvedValueOnce({
        kind: 'promoted',
        id: runner.id,
        name: runner.name,
        pid: runner.pid,
        logPath: runner.logPath,
        backend: 'native',
        reason: 'requested',
      });
      const dispose = (await runnerServerFacet.apply(harness.context)) as () => Promise<void>;
      await harness
        .tool('bash')
        .execute('call-1', { command: runner.command, background: true }, undefined, undefined, harness.execution);
      await vi.waitFor(() => expect(lifecycleMocks.container.runnerRegistry.get).toHaveBeenCalledOnce());
      const finish = (duplicate = true) => {
        lifecycleMocks.container.runnerRegistry.get.mockResolvedValue({
          ...runner,
          state: 'completed',
          exit: { reason: 'completed', code: 0, signal: null, finishedAt: '2026-08-07T00:00:05.000Z' },
        });
        notifyRegistry();
        if (duplicate) notifyRegistry();
      };
      return { harness, dispose, finish };
    };

    it('steers the agent exactly once when a runner it promoted exits', async () => {
      const { harness, dispose, finish } = await promote();
      expect(harness.execution.session.admitPrompt).not.toHaveBeenCalled();

      finish();

      await vi.waitFor(() => expect(harness.execution.session.admitPrompt).toHaveBeenCalled());
      expect(harness.execution.session.admitPrompt).toHaveBeenCalledOnce();
      expect(harness.execution.session.admitPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Background runner build exited: completed, exit code 0.'),
        'steer',
        undefined,
        `runner-finished:${JSON.stringify(['session-a', runner.id])}`,
      );
      await dispose();
    });

    it.each(['throw', 'reject'])('retries %s admission failures without registry events', async (failure) => {
      const { harness, dispose, finish } = await promote();
      const admit = vi.mocked(harness.execution.session.admitPrompt!);
      admit.mockImplementationOnce(() => {
        if (failure === 'throw') throw new Error('temporarily unavailable');
        return Promise.reject(new Error('temporarily unavailable'));
      });
      // Only the first scan should run before the independent retry timer.
      finish(false);
      await vi.waitFor(() => expect(admit).toHaveBeenCalled());
      await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(2), { timeout: 2_000 });
      await dispose();
    });

    it('reuses the completion identity after an ambiguous admission failure', async () => {
      const { harness, dispose, finish } = await promote();
      const admit = vi.mocked(harness.execution.session.admitPrompt!);
      // Acceptance can precede a failed receipt write. The next scan must reuse its identity.
      admit.mockRejectedValueOnce(new Error('receipt write failed'));
      try {
        finish();
        await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(2));
        expect(admit.mock.calls[0]![3]).toBe(`runner-finished:${JSON.stringify(['session-a', runner.id])}`);
        expect(admit.mock.calls[1]).toEqual(admit.mock.calls[0]);
      } finally {
        await dispose();
      }
    });

    it('drains delayed admission before releasing runner resources', async () => {
      const { harness, dispose, finish } = await promote();
      let accept = (): void => undefined;
      vi.mocked(harness.execution.session.admitPrompt!).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            accept = resolve;
          }),
      );
      finish();
      await vi.waitFor(() => expect(harness.execution.session.admitPrompt).toHaveBeenCalledOnce());
      const closing = dispose();
      await Promise.resolve();
      expect(lifecycleMocks.container.runnerRegistry.close).not.toHaveBeenCalled();
      accept();
      await closing;
      expect(harness.execution.session.admitPrompt).toHaveBeenCalledOnce();
      expect(lifecycleMocks.container.runnerRegistry.close).toHaveBeenCalledOnce();
    });

    it('does not start a turn for runners that session cleanup stops', async () => {
      const { harness, dispose, finish } = await promote();

      await dispose();
      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.execution.session.admitPrompt).not.toHaveBeenCalled();
      expect(lifecycleMocks.container.runnerRegistry.get).toHaveBeenCalledOnce();
      // finish() queued a completed record nobody read; drop it so it cannot leak into later tests.
      lifecycleMocks.container.runnerRegistry.get.mockReset();
    });
  });
});
