import { SUBAGENT_ROOT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerExtension } from '../src/adapters/pi/extension.ts';
import type { BashRunResult } from '../src/types/bashRunService';
import type { RunnerRecord } from '../src/types/runnerRegistry';
import type { RunnerCompactionDependencies } from '../src/services/runs/compaction.ts';
import type { BashToolDependencies } from '../src/exports/tool/bashTool';
import type { RunnerSpaceOptions } from '../src/tui/runnerSpace.ts';

const extensionMocks = vi.hoisted(() => {
  const leaderDispose = vi.fn();
  return {
    container: vi.fn(),
    registerBashTool: vi.fn(),
    registerCompaction: vi.fn(),
    openRunnerSpace: vi.fn(async (_context: unknown, _options: unknown) => undefined),
    footerUpdate: vi.fn(),
    footerDispose: vi.fn(),
    leaderDispose,
    registerLeader: vi.fn(() => ({ update: vi.fn(), dispose: leaderDispose })),
    telemetryEvent: vi.fn(async (_name: string, _attributes?: Record<string, unknown>) => undefined),
    telemetryError: vi.fn(async (_name: string, _error?: unknown, _attributes?: Record<string, unknown>) => undefined),
    telemetryShutdown: vi.fn(async () => undefined),
    createCordisRoot: vi.fn<() => Context>(),
    prepareCordisRoot: vi.fn<(root: Context) => Promise<void>>(),
    disposeCordisConnection: vi.fn(async () => undefined),
  };
});

const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => {
    const root = extensionMocks.createCordisRoot();
    await extensionMocks.prepareCordisRoot(root);
    return {
      root,
      runtime: {
        abiVersion: 1,
        hostId: 'runner-test-host',
        generation: 'runner-test-generation',
        mode: 'standalone',
      },
      dispose: extensionMocks.disposeCordisConnection,
    };
  },
}));

vi.mock('../src/container/index.ts', () => ({
  createRunnerContainer: () => extensionMocks.container(),
}));
vi.mock('../src/commands/bash/bashTool.ts', () => ({
  registerBashTool: extensionMocks.registerBashTool,
}));
vi.mock('../src/services/runs/compaction.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/runs/compaction.ts')>()),
  registerRunnerCompactionRecovery: extensionMocks.registerCompaction,
}));
vi.mock('../src/tui/runnerSpace.ts', () => ({
  openRunnerSpace: extensionMocks.openRunnerSpace,
}));
vi.mock('@agimon-ai/doompi-telemetry', () => ({
  createDoomTelemetry: () => ({
    recordEvent: extensionMocks.telemetryEvent,
    recordError: extensionMocks.telemetryError,
    shutdown: extensionMocks.telemetryShutdown,
  }),
}));

type PiHandler = (event: unknown, context: unknown) => void | Promise<void>;
type PiCommandHandler = (args: string, context: unknown) => void | Promise<void>;
type PiCommand = { handler: PiCommandHandler };

const runningRecord: RunnerRecord = {
  id: 'runner-a',
  name: 'api',
  pid: 42,
  command: 'sleep 60',
  cwd: '/repo',
  logPath: '/tmp/api.log',
  interactive: false,
  sessionId: 'session-a',
  startedAt: '2026-08-07T00:00:00.000Z',
  state: 'running',
  promoted: true,
  backend: 'native',
  hostPid: 7,
};

function completedRecord(): RunnerRecord {
  return {
    ...runningRecord,
    state: 'completed',
    exit: {
      reason: 'completed',
      code: 0,
      signal: null,
      finishedAt: '2026-08-07T00:01:00.000Z',
    },
  };
}

async function createHarness(options: { activate?: boolean } = {}) {
  const handlers = new Map<string, PiHandler>();
  const sendMessage = vi.fn();
  const setStatus = vi.fn();
  const notify = vi.fn();
  let commandHandler: PiCommandHandler = async () => undefined;
  let registryListener: (() => void) | undefined;
  let activeRecords: RunnerRecord[] = [runningRecord];
  let persistedRecord: RunnerRecord | undefined = runningRecord;
  const sweepHistoryAsync = vi.fn(async () => ({ removed: [], errors: [] }));
  const registry = {
    subscribe: vi.fn((listener: () => void) => {
      registryListener = listener;
      return vi.fn();
    }),
    list: vi.fn(async () => activeRecords),
    listAcrossRepositories: vi.fn(async () => []),
    listBySession: vi.fn(async (sessionId: string) => activeRecords.filter((record) => record.sessionId === sessionId)),
    listByRootSession: vi.fn(async () => activeRecords),
    listAll: vi.fn(async () => [runningRecord]),
    get: vi.fn(async () => persistedRecord),
    release: vi.fn(async (id: string) => {
      activeRecords = activeRecords.filter((record) => record.id !== id);
    }),
    complete: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const launcher = { stop: vi.fn(async () => true) };
  const rmuxBackend = { readOutcome: vi.fn(), stop: vi.fn(async () => true), get: vi.fn() };
  const ptyHost = { get: vi.fn(), disposeAll: vi.fn(async () => undefined) };
  const bashRunService = { run: vi.fn() };
  const paths = {
    setSessionId: vi.fn(),
    legacyDirectory: vi.fn(() => undefined),
    sweepHistory: vi.fn(() => ({ removed: [], errors: [] })),
    sweepHistoryAsync,
  };
  const processControl = { isAlive: vi.fn(() => true) };
  const lifeline = { arm: vi.fn(async (): Promise<void> => undefined), dispose: vi.fn() };
  extensionMocks.container.mockImplementation(() => ({
    runnerRegistry: registry,
    launcher,
    rmuxBackend,
    logReader: { read: vi.fn(() => ({ text: '' })) },
    ptyHost,
    bashRunService,
    paths,
    processControl,
    lifeline,
  }));

  const pi = {
    events: {},
    on: (event: string, handler: PiHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: vi.fn((_name: string, command: PiCommand) => {
      commandHandler = command.handler;
    }),
    sendMessage,
  } as unknown as ExtensionAPI;
  const context = {
    cwd: '/repo',
    hasUI: true,
    sessionManager: { getSessionId: () => 'session-a' },
    ui: { setStatus, notify },
  };

  const activation = options.activate === false ? undefined : runnerExtension(pi);
  await activation;

  return {
    activation,
    pi,
    handlers,
    context,
    registry,
    launcher,
    rmuxBackend,
    ptyHost,
    bashRunService,
    paths,
    processControl,
    lifeline,
    sendMessage,
    setStatus,
    notify,
    sweepHistoryAsync,
    command: () => commandHandler,
    registryListener: () => registryListener?.(),
    bashDependencies: () => extensionMocks.registerBashTool.mock.calls.at(-1)?.[1] as BashToolDependencies,
    compactionDependencies: () =>
      extensionMocks.registerCompaction.mock.calls.at(-1)?.[1] as RunnerCompactionDependencies,
    setPersisted: (record: RunnerRecord | undefined) => {
      persistedRecord = record;
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function startSession(
  harness: Awaited<ReturnType<typeof createHarness>>,
  context: Awaited<ReturnType<typeof createHarness>>['context'] = harness.context,
): Promise<void> {
  const sessionStart = harness.handlers.get('session_start')?.({}, context);
  expect(sessionStart).toBeUndefined();
  await harness.bashDependencies().getSessionId();
}

let previousRootSession: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  extensionMocks.registerLeader.mockImplementation(() => ({
    update: vi.fn(),
    dispose: extensionMocks.leaderDispose,
  }));
  extensionMocks.telemetryEvent.mockImplementation(async () => undefined);
  extensionMocks.telemetryError.mockImplementation(async () => undefined);
  extensionMocks.telemetryShutdown.mockImplementation(async () => undefined);
  extensionMocks.createCordisRoot.mockImplementation(() => {
    const root = new Context();
    cordisRoots.push(root);
    return root;
  });
  extensionMocks.prepareCordisRoot.mockImplementation(async (root) => {
    const hub = {
      registerConfig: vi.fn(),
      registerFooter: vi.fn(() => ({
        update: extensionMocks.footerUpdate,
        dispose: extensionMocks.footerDispose,
      })),
      registerLeader: extensionMocks.registerLeader,
      registerLeaderActions: vi.fn(),
    } as unknown as DoomUiHubService;
    await root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, hub));
  });
  extensionMocks.disposeCordisConnection.mockImplementation(async () => undefined);
  vi.useFakeTimers();
  previousRootSession = process.env[SUBAGENT_ROOT_SESSION_ENV];
  delete process.env[SUBAGENT_ROOT_SESSION_ENV];
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previousRootSession === undefined) delete process.env[SUBAGENT_ROOT_SESSION_ENV];
  else process.env[SUBAGENT_ROOT_SESSION_ENV] = previousRootSession;
});

describe('runnerExtension refresh', () => {
  it('defers history retention cleanup until after startup resolves', async () => {
    const harness = await createHarness();

    await startSession(harness);

    expect(harness.sweepHistoryAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.sweepHistoryAsync).toHaveBeenCalledOnce();
    await harness.handlers.get('session_shutdown')?.({}, harness.context);
  });

  it('does not hold Pi session_start open while runner initialization is pending', async () => {
    const harness = await createHarness();
    let releaseLifeline: (() => void) | undefined;
    harness.lifeline.arm.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseLifeline = resolve;
        }),
    );

    const sessionStart = harness.handlers.get('session_start')?.({}, harness.context);
    expect(sessionStart).toBeUndefined();
    await flushPromises();
    expect(harness.lifeline.arm).toHaveBeenCalledWith('session-a');
    expect(harness.registry.listAll).not.toHaveBeenCalled();

    releaseLifeline?.();
    await expect(harness.bashDependencies().getSessionId()).resolves.toBe('session-a');
    await harness.handlers.get('session_shutdown')?.({}, harness.context);
  });

  it('does not render or mutate UI status in a headless session', async () => {
    const harness = await createHarness();
    harness.context.hasUI = false;

    await startSession(harness);
    await harness.command()('', harness.context);

    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith('/runners requires interactive mode', 'error');
    expect(harness.sendMessage).not.toHaveBeenCalled();
    await harness.handlers.get('session_shutdown')?.({}, harness.context);
  });

  it('hydrates history once, monitors exact promoted IDs, and deduplicates completion', async () => {
    const harness = await createHarness();
    await startSession(harness);
    const startupHistoryCalls = harness.registry.listAll.mock.calls.length;
    const bashDependencies = extensionMocks.registerBashTool.mock.calls[0]?.[1] as BashToolDependencies;

    expect(startupHistoryCalls).toBe(1);
    expect(extensionMocks.footerUpdate).toHaveBeenCalledOnce();
    expect(bashDependencies.onRunnerStarted).toBeTypeOf('function');

    harness.setPersisted(completedRecord());
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.registry.listAll).toHaveBeenCalledTimes(startupHistoryCalls);
    expect(harness.registry.get).toHaveBeenCalledWith(runningRecord.id, runningRecord.sessionId);
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const publishedCount = extensionMocks.footerUpdate.mock.calls.length;

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(extensionMocks.footerUpdate).toHaveBeenCalledTimes(publishedCount);
    await harness.handlers.get('session_shutdown')?.({}, harness.context);
  });

  it('coalesces concurrent triggers and preserves a queued reconciliation pass', async () => {
    const harness = await createHarness();
    await startSession(harness);
    const bashDependencies = extensionMocks.registerBashTool.mock.calls[0]?.[1] as BashToolDependencies;
    const callsBefore = harness.registry.list.mock.calls.length;
    let resolveList: (() => void) | undefined;
    let concurrent = 0;
    let maximumConcurrent = 0;
    let blockNext = true;
    harness.registry.list.mockImplementation(async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (blockNext) {
        blockNext = false;
        await new Promise<void>((resolve) => {
          resolveList = resolve;
        });
      }
      concurrent -= 1;
      return [];
    });

    bashDependencies.onRunnerStarted('runner-b');
    harness.registryListener();
    vi.advanceTimersByTime(500);
    resolveList?.();
    await flushPromises();

    expect(maximumConcurrent).toBe(1);
    expect(harness.registry.list).toHaveBeenCalledTimes(callsBefore + 2);
    await harness.handlers.get('session_shutdown')?.({}, harness.context);
  });

  it('settles an in-flight refresh before closing the registry during shutdown', async () => {
    const harness = await createHarness();
    await startSession(harness);
    const bashDependencies = extensionMocks.registerBashTool.mock.calls[0]?.[1] as BashToolDependencies;
    let resolveList: (() => void) | undefined;
    harness.registry.list.mockImplementationOnce(
      () =>
        new Promise<RunnerRecord[]>((resolve) => {
          resolveList = () => resolve([]);
        }),
    );

    bashDependencies.onRunnerStarted('runner-b');
    await flushPromises();
    const shutdown = harness.handlers.get('session_shutdown')?.({}, harness.context);
    await flushPromises();

    expect(harness.registry.close).not.toHaveBeenCalled();
    resolveList?.();
    await shutdown;

    expect(harness.registry.close).toHaveBeenCalledOnce();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('cleans up the session only once when shutdown is delivered repeatedly', async () => {
    const harness = await createHarness();
    await startSession(harness);
    const statusCallsBeforeShutdown = harness.setStatus.mock.calls.length;

    await harness.handlers.get('session_shutdown')?.({}, harness.context);
    await harness.handlers.get('session_shutdown')?.({}, harness.context);

    expect(harness.registry.close).toHaveBeenCalledOnce();
    expect(harness.registry.complete).toHaveBeenCalledOnce();
    expect(harness.registry.listBySession).toHaveBeenCalledOnce();
    expect(harness.setStatus).toHaveBeenCalledWith('doom-runner-runners', undefined);
    expect(harness.setStatus).toHaveBeenCalledTimes(statusCallsBeforeShutdown + 1);
  });

  it('closes an acquired registry when service graph resolution fails', async () => {
    const harness = await createHarness({ activate: false });
    // The graph resolves lazily, so only the registry is reachable before the
    // failure; every other slot throws when the extension reaches for it.
    extensionMocks.container.mockImplementation(() => ({
      get runnerRegistry() {
        return harness.registry;
      },
      get launcher(): never {
        throw new Error('service graph failed');
      },
    }));

    await expect(runnerExtension(harness.pi)).rejects.toThrow('service graph failed');
    expect(harness.registry.close).toHaveBeenCalledOnce();
  });

  it('keeps the core runtime active when an optional UI integration fails', async () => {
    const harness = await createHarness({ activate: false });
    extensionMocks.registerLeader.mockImplementationOnce(() => {
      throw new Error('leader unavailable');
    });

    await expect(runnerExtension(harness.pi)).resolves.toBeUndefined();
    await flushPromises();
    await expect(harness.handlers.get('session_shutdown')?.({}, harness.context)).resolves.toBeUndefined();

    expect(extensionMocks.footerDispose).toHaveBeenCalledOnce();
    expect(harness.ptyHost.disposeAll).toHaveBeenCalledOnce();
    expect(harness.lifeline.dispose).toHaveBeenCalledOnce();
    expect(harness.registry.close).toHaveBeenCalledOnce();
  });

  it('gates command, compaction, and process controls to the active generation', async () => {
    const harness = await createHarness();
    const compaction = harness.compactionDependencies();
    await harness.command()('', harness.context);
    expect(extensionMocks.openRunnerSpace).not.toHaveBeenCalled();
    await expect(compaction.getSessionId()).resolves.toBeUndefined();

    await startSession(harness);
    await expect(harness.bashDependencies().getSessionId()).resolves.toBe('session-a');
    await expect(compaction.getSessionId()).resolves.toBe('session-a');
    await expect(compaction.listBySession('session-a')).resolves.toEqual([runningRecord]);

    await harness.command()('', harness.context);
    const nativeOptions = extensionMocks.openRunnerSpace.mock.calls.at(-1)?.[1] as RunnerSpaceOptions;
    expect(nativeOptions.getRunners()).toEqual([runningRecord]);
    expect(nativeOptions.getPtyRun('api')).toBeUndefined();
    expect(nativeOptions.readLog(runningRecord.logPath)).toBe('');
    await nativeOptions.stopRunner('missing', 'not found');
    await nativeOptions.stopRunner(runningRecord.id, 'manual stop');
    expect(harness.launcher.stop).toHaveBeenCalledWith(runningRecord.pid);

    const rmuxRecord: RunnerRecord = {
      ...runningRecord,
      backend: 'rmux',
      backendTarget: 'runner-api',
    };
    harness.registry.list.mockResolvedValueOnce([rmuxRecord]);
    await harness.command()('', harness.context);
    const rmuxOptions = extensionMocks.openRunnerSpace.mock.calls.at(-1)?.[1] as RunnerSpaceOptions;
    harness.rmuxBackend.get.mockReturnValueOnce({});
    expect(rmuxOptions.getPtyRun('api')).toEqual({});
    await rmuxOptions.stopRunner(rmuxRecord.id, 'manual stop');
    expect(harness.rmuxBackend.stop).toHaveBeenCalledWith('runner-api', rmuxRecord.pid);

    await harness.handlers.get('session_shutdown')?.({}, harness.context);
    expect(nativeOptions.getRunners()).toEqual([]);
    expect(nativeOptions.getPtyRun('api')).toBeUndefined();
    expect(nativeOptions.readLog(runningRecord.logPath)).toBe('');
    await nativeOptions.stopRunner(runningRecord.id, 'stale');
    await harness.command()('', harness.context);
    await expect(compaction.getSessionId()).resolves.toBeUndefined();
    await expect(compaction.listBySession('session-a')).resolves.toEqual([]);
  });

  it('fences registry, timer, and bash callbacks after shutdown', async () => {
    const harness = await createHarness();
    await startSession(harness);
    const bashDependencies = harness.bashDependencies();
    await harness.handlers.get('session_shutdown')?.({}, harness.context);
    harness.registry.list.mockClear();
    harness.setStatus.mockClear();
    harness.sendMessage.mockClear();

    harness.registryListener();
    bashDependencies.onRunnerStarted('runner-stale');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(bashDependencies.getSessionId()).rejects.toThrow('doom-runner requires an active Pi session');
    expect(harness.registry.list).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('creates a fresh Cordis-owned runtime after the previous factory shuts down', async () => {
    const first = await createHarness();
    await first.activation;
    await startSession(first);
    await first.handlers.get('session_shutdown')?.({}, first.context);

    const second = await createHarness();
    await second.activation;
    await startSession(second);

    expect(extensionMocks.registerBashTool).toHaveBeenCalledTimes(2);
    expect(second.lifeline.arm).toHaveBeenCalledWith('session-a');
    expect(first.registry.close).toHaveBeenCalledOnce();
    expect(second.registry.close).not.toHaveBeenCalled();

    await second.handlers.get('session_shutdown')?.({}, second.context);
    expect(second.registry.close).toHaveBeenCalledOnce();
    expect(extensionMocks.footerDispose).toHaveBeenCalledTimes(2);
  });

  it('awaits detached telemetry work before closing owned resources', async () => {
    const harness = await createHarness();
    await startSession(harness);
    let resolveTelemetry: (() => void) | undefined;
    extensionMocks.telemetryEvent.mockImplementation(async (name: string) => {
      if (name !== 'doom_runner.process_finished') return;
      await new Promise<void>((resolve) => {
        resolveTelemetry = resolve;
      });
    });
    harness.setPersisted(completedRecord());

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    const shutdown = harness.handlers.get('session_shutdown')?.({}, harness.context);
    await flushPromises();

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.registry.close).not.toHaveBeenCalled();
    resolveTelemetry?.();
    await shutdown;
    expect(harness.registry.close).toHaveBeenCalledOnce();
  });

  it('awaits an in-flight bash operation before closing the registry', async () => {
    const harness = await createHarness();
    await startSession(harness);
    let resolveRun: ((result: BashRunResult) => void) | undefined;
    harness.bashRunService.run.mockImplementationOnce(
      () =>
        new Promise<BashRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const run = harness.bashDependencies().bashRunService.run({
      command: 'echo done',
      sessionId: 'session-a',
    });
    const shutdown = harness.handlers.get('session_shutdown')?.({}, harness.context);
    await flushPromises();

    expect(harness.registry.close).not.toHaveBeenCalled();
    resolveRun?.({
      kind: 'completed',
      id: 'runner-complete',
      name: 'echo',
      output: 'done',
      exitCode: 0,
      signal: null,
      logPath: '/tmp/echo.log',
      backend: 'native',
    });
    await run;
    await shutdown;
    expect(harness.registry.close).toHaveBeenCalledOnce();
  });

  it('fences a stale session context while replacing session-owned resources', async () => {
    const harness = await createHarness();
    let resolveHistory: ((records: RunnerRecord[]) => void) | undefined;
    harness.registry.listAll.mockImplementationOnce(
      () =>
        new Promise<RunnerRecord[]>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const firstStart = harness.handlers.get('session_start')?.({}, harness.context);
    expect(firstStart).toBeUndefined();
    await flushPromises();

    const nextSetStatus = vi.fn();
    const nextContext = {
      ...harness.context,
      sessionManager: { getSessionId: () => 'session-b' },
      ui: { ...harness.context.ui, setStatus: nextSetStatus },
    };
    const nextStart = harness.handlers.get('session_start')?.({}, nextContext);
    expect(nextStart).toBeUndefined();
    resolveHistory?.([runningRecord]);
    await expect(harness.bashDependencies().getSessionId()).resolves.toBe('session-b');

    expect(harness.paths.setSessionId).toHaveBeenLastCalledWith('session-b');
    expect(harness.lifeline.arm).toHaveBeenLastCalledWith('session-b');
    expect(harness.setStatus).toHaveBeenCalledTimes(1);
    expect(harness.setStatus).toHaveBeenCalledWith('doom-runner-runners', undefined);
    expect(nextSetStatus).toHaveBeenCalled();

    await harness.handlers.get('session_shutdown')?.({}, nextContext);
  });

  it('continues teardown when individual cleanup operations fail', async () => {
    const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const harness = await createHarness();
    await startSession(harness);
    harness.ptyHost.disposeAll.mockRejectedValueOnce(new Error('pty host failed'));
    harness.registry.listBySession.mockRejectedValueOnce(new Error('registry list failed'));
    harness.lifeline.dispose.mockImplementationOnce(() => {
      throw new Error('lifeline failed');
    });
    extensionMocks.footerDispose.mockImplementationOnce(() => {
      throw new Error('footer failed');
    });
    extensionMocks.leaderDispose.mockImplementationOnce(() => {
      throw new Error('leader failed');
    });
    harness.setStatus.mockImplementationOnce(() => {
      throw new Error('status failed');
    });
    harness.registry.close.mockImplementationOnce(() => {
      throw new Error('registry close failed');
    });
    extensionMocks.telemetryEvent.mockRejectedValueOnce(new Error('telemetry event failed'));
    extensionMocks.telemetryShutdown.mockRejectedValueOnce(new Error('telemetry shutdown failed'));

    await expect(harness.handlers.get('session_shutdown')?.({}, harness.context)).resolves.toBeUndefined();

    expect(extensionMocks.telemetryShutdown).toHaveBeenCalledOnce();
    expect(warnings.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
});
