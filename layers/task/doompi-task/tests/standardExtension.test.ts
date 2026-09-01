import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import {
  createDoomContextContributionsService,
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/context-contributions';
import { DOOM_DELEGATION_SERVICE, type DoomDelegationService } from '@agimon-ai/doompi-extension-contracts/delegation';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_NARRATION_SERVICE, type DoomNarrationService } from '@agimon-ai/doompi-extension-contracts/narration';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  createCordisRoot: (): unknown => undefined,
  backgroundDispose: vi.fn(),
  configureSession: vi.fn(),
  createDelegation: vi.fn(),
  createOverlay: vi.fn(),
  createStore: vi.fn(),
  delegationDispose: vi.fn(),
  delegationBind: vi.fn(() => () => undefined),
  delegationReconcile: vi.fn(async () => undefined),
  delegationReset: vi.fn(),
  leaderDispose: vi.fn(),
  narrateTaskCommit: vi.fn(),
  narrationWarning: vi.fn(async () => undefined),
  onExternalChange: vi.fn(),
  overlayDispose: vi.fn(),
  overlayUpdate: vi.fn(),
  readStore: vi.fn(async () => undefined),
  reportError: vi.fn(),
  reportWarn: vi.fn(),
  registerBackgroundWork: vi.fn(),
  registerLeader: vi.fn(),
  removeLegacyStore: vi.fn(async (): Promise<{ removed: string[]; errors: string[] }> => ({ removed: [], errors: [] })),
  reporterShutdown: vi.fn(async () => undefined),
  storeDispose: vi.fn(),
  sweepStore: vi.fn(async (): Promise<{ removed: string[]; errors: string[] }> => ({ removed: [], errors: [] })),
  taskCommitListener: undefined as ((previous: unknown, committed: unknown) => void) | undefined,
  unwatch: vi.fn(),
}));
const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => ({
    root: runtimeMocks.createCordisRoot(),
    runtime: { abiVersion: 1, generation: 'task-test', hostId: 'task-test', mode: 'composed' },
    dispose: async () => undefined,
  }),
}));
vi.mock('../src/commands/index.ts', () => ({ registerTasksCommand: vi.fn() }));
vi.mock('../src/commands/task/taskTool.ts', () => ({ registerTaskTool: vi.fn() }));
vi.mock('../src/services/delegation/manager.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/delegation/manager.ts')>()),
  DelegationManager: class {
    constructor() {
      runtimeMocks.createDelegation();
    }
    bind = runtimeMocks.delegationBind;
    dispose = runtimeMocks.delegationDispose;
    listActiveWork = () => [];
    reconcile = runtimeMocks.delegationReconcile;
    reset = runtimeMocks.delegationReset;
  },
}));
vi.mock('../src/services/narration/taskNarration.ts', () => ({ narrateTaskCommit: runtimeMocks.narrateTaskCommit }));
vi.mock('../src/adapters/store/paths', () => ({
  hasStorePathOverride: () => false,
  removeLegacyStoreDirectoryAsync: runtimeMocks.removeLegacyStore,
  resolveSessionKey: (sessionId: string) => sessionId,
  sweepStoreFilesAsync: runtimeMocks.sweepStore,
}));
vi.mock('../src/adapters/store/taskStore', () => ({
  TaskStore: class {
    readonly snapshot = { tasks: [] };
    readonly storePath = '/tmp/doom-task/tasks.json';
    constructor(options: { onCommitted?: (previous: unknown, committed: unknown) => void }) {
      runtimeMocks.createStore();
      runtimeMocks.taskCommitListener = options.onCommitted;
    }
    configureSession = runtimeMocks.configureSession;
    dispose = runtimeMocks.storeDispose;
    onExternalChange = runtimeMocks.onExternalChange;
    readAsync = runtimeMocks.readStore;
  },
}));
vi.mock('../src/tui/taskOverlay.ts', () => ({
  TaskOverlay: class {
    constructor() {
      runtimeMocks.createOverlay();
    }
    dispose = runtimeMocks.overlayDispose;
    isRegistered = () => false;
    setUICtx = vi.fn();
    toggleCollapse = vi.fn();
    update = runtimeMocks.overlayUpdate;
  },
}));
vi.mock('../src/types/config.ts', () => ({
  COLLAPSE_KEY_OFF: 'off',
  getDelegationTimeoutMs: () => 1_000,
  getMaxTasks: () => 20,
  getStoreTtlMs: () => 60_000,
  resolveCollapseKey: () => 'off',
}));
vi.mock('../src/adapters/telemetry/logSinkTelemetry.ts', () => ({
  TASK_EVENT: {
    sessionStartFailed: 'session-start-failed',
    sessionStartDegraded: 'session-start-degraded',
    storeSweepFailed: 'store-sweep-failed',
  },
  createTaskErrorReporter: () => ({
    recordNotificationError: vi.fn(async () => undefined),
    recordWarning: runtimeMocks.narrationWarning,
    shutdown: runtimeMocks.reporterShutdown,
  }),
  toFailureReporter: () => ({
    error: runtimeMocks.reportError,
    warn: runtimeMocks.reportWarn,
    event: vi.fn(),
  }),
}));

const { taskExtension } = await import('../src/adapters/pi/extension.ts');

interface TestPi {
  pi: ExtensionAPI;
  handler(name: string): (...args: unknown[]) => unknown;
}

function createPi(): TestPi {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    pi: {
      events: {},
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI,
    handler(name: string) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing ${name} handler.`);
      return handler;
    },
  };
}

beforeEach(() => {
  runtimeMocks.createCordisRoot = () => {
    const root = new Context();
    const backgroundWork: DoomBackgroundWorkService = {
      generation: 'background-test',
      register: runtimeMocks.registerBackgroundWork,
      snapshot: () => ({ items: [], errors: [] }),
    };
    const delegation: DoomDelegationService = {
      sessionId: 'task-test',
      generation: 'delegation-test',
      request: async () => undefined,
      cancel: () => undefined,
    };
    root.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWork);
    root.provide(DOOM_DELEGATION_SERVICE, delegation);
    const uiHub = {
      registerLeader: runtimeMocks.registerLeader,
    } as unknown as DoomUiHubService;
    root.provide(DOOM_UI_HUB_SERVICE, uiHub);
    cordisRoots.push(root);
    return root;
  };
  runtimeMocks.onExternalChange.mockReturnValue(runtimeMocks.unwatch);
  runtimeMocks.registerBackgroundWork.mockReturnValue({
    dispose: runtimeMocks.backgroundDispose,
    update: vi.fn(),
  });
  runtimeMocks.registerLeader.mockReturnValue({ dispose: runtimeMocks.leaderDispose, update: vi.fn() });
  runtimeMocks.taskCommitListener = undefined;
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.clearAllMocks();
});

describe('standard Task extension lifecycle', () => {
  it('releases Pi session_start while shared readiness owns deferred store initialization', async () => {
    let finishCleanup: (() => void) | undefined;
    runtimeMocks.removeLegacyStore.mockImplementationOnce(
      () =>
        new Promise<{ removed: string[]; errors: string[] }>((resolve) => {
          finishCleanup = () => resolve({ removed: [], errors: [] });
        }),
    );
    const fixture = createPi();
    const sessionManager = { getSessionId: () => 'session-ready' };
    const coordinator = createDoomReadinessCoordinator();
    await taskExtension(fixture.pi);
    cordisRoots.at(-1)?.provide(DOOM_READINESS_SERVICE, coordinator);

    await expect(fixture.handler('session_start')({}, { hasUI: false, sessionManager })).resolves.toBeUndefined();
    expect(runtimeMocks.configureSession).toHaveBeenCalledOnce();
    expect(runtimeMocks.sweepStore).not.toHaveBeenCalled();

    finishCleanup?.();
    await vi.waitFor(() => expect(runtimeMocks.readStore).toHaveBeenCalledOnce());
    await fixture.handler('session_shutdown')();
    await coordinator.dispose();
  });

  it('awaits idempotent cleanup and fences deferred session initialization', async () => {
    let finishCleanup: (() => void) | undefined;
    runtimeMocks.removeLegacyStore.mockImplementationOnce(
      () =>
        new Promise<{ removed: string[]; errors: string[] }>((resolve) => {
          finishCleanup = () => resolve({ removed: [], errors: [] });
        }),
    );
    const fixture = createPi();
    await taskExtension(fixture.pi);
    const sessionStart = Promise.resolve(
      fixture.handler('session_start')({}, { hasUI: false, sessionManager: { getSessionId: () => 'session-1' } }),
    );

    const shutdown = Promise.all([
      Promise.resolve(fixture.handler('session_shutdown')()),
      Promise.resolve(fixture.handler('session_shutdown')()),
    ]);
    await Promise.resolve();
    expect(runtimeMocks.reporterShutdown).not.toHaveBeenCalled();
    finishCleanup?.();
    await Promise.all([shutdown, sessionStart]);

    expect(runtimeMocks.reporterShutdown).toHaveBeenCalledOnce();
    expect(runtimeMocks.backgroundDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.delegationDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.overlayDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.storeDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.sweepStore).not.toHaveBeenCalled();
    expect(runtimeMocks.readStore).not.toHaveBeenCalled();
    await expect(
      fixture.handler('session_start')({}, { hasUI: false, sessionManager: { getSessionId: () => 'stale-session' } }),
    ).resolves.toBeUndefined();
    expect(runtimeMocks.configureSession).toHaveBeenCalledOnce();
  });

  it('recreates session resources without retaining the previous session', async () => {
    const fixture = createPi();
    await taskExtension(fixture.pi);

    await fixture.handler('session_start')({}, { hasUI: false, sessionManager: { getSessionId: () => 'session-1' } });
    await fixture.handler('session_start')({}, { hasUI: false, sessionManager: { getSessionId: () => 'session-2' } });
    await fixture.handler('session_shutdown')();

    expect(runtimeMocks.configureSession).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.readStore).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.delegationReset).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.delegationReconcile).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.unwatch).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.backgroundDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.delegationDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.overlayDispose).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.storeDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.reporterShutdown).toHaveBeenCalledOnce();
  });

  it('owns the injected leader contribution through the Cordis root lifecycle', async () => {
    const fixture = createPi();

    await taskExtension(fixture.pi);
    expect(runtimeMocks.registerLeader).toHaveBeenCalledOnce();

    await cordisRoots.at(-1)?.fiber.dispose();

    expect(runtimeMocks.delegationDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.overlayDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.storeDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.reporterShutdown).toHaveBeenCalledOnce();
    expect(runtimeMocks.leaderDispose).toHaveBeenCalledOnce();
  });

  it('drops narration on provider loss and sends later requests to the replacement provider', async () => {
    const fixture = createPi();
    await taskExtension(fixture.pi);
    runtimeMocks.taskCommitListener?.({}, {});
    const sink = runtimeMocks.narrateTaskCommit.mock.calls.at(-1)?.[0] as { narrate(text: string): void } | undefined;
    if (!sink) throw new Error('Task narration sink was not installed.');

    const root = cordisRoots.at(-1);
    if (!root) throw new Error('Task Cordis root is unavailable.');
    const firstRequest = vi.fn();
    const firstService: DoomNarrationService = {
      generation: 'task-narration-first',
      request: firstRequest,
    };
    const firstProvider = root.plugin((context) => context.provide(DOOM_NARRATION_SERVICE, firstService));
    await firstProvider;
    sink.narrate('First provider.');
    expect(firstRequest).toHaveBeenCalledWith({ text: 'First provider.' });

    await firstProvider.dispose();
    sink.narrate('No provider.');
    expect(firstRequest).toHaveBeenCalledOnce();

    const secondRequest = vi.fn().mockRejectedValue(new Error('narration unavailable'));
    const secondService: DoomNarrationService = {
      generation: 'task-narration-second',
      request: secondRequest,
    };
    const secondProvider = root.plugin((context) => context.provide(DOOM_NARRATION_SERVICE, secondService));
    await secondProvider;
    sink.narrate('Replacement provider.');
    expect(secondRequest).toHaveBeenCalledWith({ text: 'Replacement provider.' });
    await vi.waitFor(() =>
      expect(runtimeMocks.narrationWarning).toHaveBeenCalledWith(
        'doom_task.narration_failed',
        expect.objectContaining({ message: 'narration unavailable' }),
      ),
    );

    await fixture.handler('session_shutdown')();
  });

  it('moves its context contribution to a replacement broker without retaining the old provider', async () => {
    const fixture = createPi();
    await taskExtension(fixture.pi);
    const root = cordisRoots.at(-1);
    if (!root) throw new Error('Task Cordis root is unavailable.');

    const firstService = createDoomContextContributionsService('task-context-first');
    const firstProvider = root.plugin((context) => context.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, firstService));
    await firstProvider;
    expect(firstService.snapshot().entries).toEqual([
      expect.objectContaining({
        source: '@agimon-ai/doompi-task',
        id: 'active-tasks',
        order: 100,
        text: '(no active tasks)',
      }),
    ]);

    await firstProvider.dispose();
    expect(firstService.snapshot().entries).toEqual([]);

    const secondService = createDoomContextContributionsService('task-context-second');
    const secondProvider = root.plugin((context) => context.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, secondService));
    await secondProvider;
    expect(secondService.snapshot().entries).toEqual([
      expect.objectContaining({ source: '@agimon-ai/doompi-task', id: 'active-tasks' }),
    ]);

    await fixture.handler('session_shutdown')();
    expect(secondService.snapshot().entries).toEqual([]);
  });

  it('recreates independent resources for every factory activation', async () => {
    const first = createPi();
    const second = createPi();

    await taskExtension(first.pi);
    await taskExtension(second.pi);
    await Promise.resolve(first.handler('session_shutdown')());
    await Promise.resolve(second.handler('session_shutdown')());

    expect(runtimeMocks.createStore).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.createDelegation).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.createOverlay).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.reporterShutdown).toHaveBeenCalledTimes(2);
  });
});

describe('Task session start failure reporting', () => {
  it('reports a fatal session start with a stage and a non-empty error type', async () => {
    const fixture = createPi();
    await taskExtension(fixture.pi);

    await expect(fixture.handler('session_start')({}, { hasUI: false })).rejects.toThrow(
      'doom-task requires a session id',
    );

    expect(runtimeMocks.reportError).toHaveBeenCalledWith(
      'session-start-failed',
      expect.any(Error),
      expect.objectContaining({ 'task.stage': 'session_id', 'error.type': 'Error' }),
    );
    const attributes = runtimeMocks.reportError.mock.calls.at(-1)?.[2] as Record<string, string>;
    expect(attributes['error.type']).not.toBe('');
    await fixture.handler('session_shutdown')();
  });

  it('starts the session with an empty task list when the store read fails', async () => {
    runtimeMocks.readStore.mockRejectedValueOnce(new TypeError('corrupt store'));
    const fixture = createPi();
    await taskExtension(fixture.pi);

    await expect(
      fixture.handler('session_start')({}, { hasUI: false, sessionManager: { getSessionId: () => 'session-read' } }),
    ).resolves.toBeUndefined();

    expect(runtimeMocks.reportWarn).toHaveBeenCalledWith(
      'session-start-degraded',
      expect.any(TypeError),
      expect.objectContaining({ 'task.stage': 'store_read', 'error.type': 'TypeError' }),
    );
    expect(runtimeMocks.reportError).not.toHaveBeenCalled();
    expect(runtimeMocks.delegationReconcile).toHaveBeenCalledOnce();
    await fixture.handler('session_shutdown')();
  });

  it('starts the session when delegation reconciliation fails', async () => {
    runtimeMocks.delegationReconcile.mockRejectedValueOnce(new Error('reconcile unavailable'));
    const fixture = createPi();
    await taskExtension(fixture.pi);

    await expect(
      fixture.handler('session_start')(
        {},
        { hasUI: false, sessionManager: { getSessionId: () => 'session-reconcile' } },
      ),
    ).resolves.toBeUndefined();

    expect(runtimeMocks.reportWarn).toHaveBeenCalledWith(
      'session-start-degraded',
      expect.any(Error),
      expect.objectContaining({ 'task.stage': 'reconcile', 'error.type': 'Error' }),
    );
    expect(runtimeMocks.reportError).not.toHaveBeenCalled();
    await fixture.handler('session_shutdown')();
  });
});
