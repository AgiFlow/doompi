import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type BackgroundWorkProviderHandle,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  requireDoomContextContributions,
} from '@agimon-ai/doompi-extension-contracts/context-contributions';
import { DOOM_DELEGATION_SERVICE, readDoomDelegationService } from '@agimon-ai/doompi-extension-contracts/delegation';
import {
  createNarrationRequest,
  DOOM_NARRATION_SERVICE,
  type DoomNarrationService,
  requireDoomNarrationService,
} from '@agimon-ai/doompi-extension-contracts/narration';
import { readDoomReadinessCoordinator } from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import { registerTasksCommand } from '../../commands/index.ts';
import { registerTaskTool } from '../../commands/task/taskTool.ts';
import { COMMAND_NAME, TOOL_NAME } from '../../schemas/task.ts';
import { BACKGROUND_WORK_PROVIDER, DelegationManager, NOTIFY_CUSTOM_TYPE } from '../../services/delegation/manager.ts';
import { createTaskContextContribution, TASK_CONTEXT_CONTRIBUTION_SOURCE } from '../../services/contextContribution.ts';
import { narrateTaskCommit, type TaskNarrationSink } from '../../services/narration/taskNarration.ts';
import {
  hasStorePathOverride,
  removeLegacyStoreDirectoryAsync,
  resolveSessionKey,
  sweepStoreFilesAsync,
} from '../../adapters/store/paths';
import { TaskStore } from '../../adapters/store/taskStore';
import { TaskOverlay } from '../../tui/taskOverlay.ts';
import {
  COLLAPSE_KEY_OFF,
  getDelegationTimeoutMs,
  getMaxTasks,
  getStoreTtlMs,
  resolveCollapseKey,
} from '../../types/config.ts';
import { createNodeDelegationPlatform } from '../node/delegationPlatform.ts';
import { createTaskErrorReporter, TASK_EVENT, toFailureReporter } from '../telemetry/logSinkTelemetry.ts';

interface SessionContextLike {
  hasUI: boolean;
  ui: Parameters<TaskOverlay['setUICtx']>[0];
  sessionManager?: { getSessionId(): string };
}

const LEADER_SOURCE = TASK_CONTEXT_CONTRIBUTION_SOURCE;
const NARRATION_FAILED_EVENT = 'doom_task.narration_failed';
/** Between doom-plan's 60 and the core help group's 70, so `t` sits after `p`. */
const LEADER_GROUP_ORDER = 65;
const SESSION_START_EVENT = 'session_start';
const SESSION_COMPACT_EVENT = 'session_compact';
const SESSION_TREE_EVENT = 'session_tree';
const TOOL_EXECUTION_END_EVENT = 'tool_execution_end';

/** Install Task state and external resources into its host-owned Cordis plugin fiber. */
export function installTaskRuntime(cordis: Context, pi: ExtensionAPI): void {
  const errorReporter = createTaskErrorReporter();
  const report = toFailureReporter(errorReporter);
  let active = true;
  let sessionGeneration = 0;
  let narrationService: DoomNarrationService | undefined;
  let store: TaskStore | undefined;
  let delegation: DelegationManager | undefined;
  let overlay: TaskOverlay | undefined;
  let unwatch: (() => void) | undefined;
  let backgroundWork: BackgroundWorkProviderHandle | undefined;
  let backgroundWorkEnabled = false;
  let disposeLeader: (() => void) | undefined;
  let sessionId: string | undefined;
  let sessionInitialization:
    | {
        readonly sessionManager: object;
        readonly operation: Promise<void>;
      }
    | undefined;

  const reportNarrationFailure = (error: unknown): void => {
    void errorReporter.recordWarning(NARRATION_FAILED_EVENT, error).catch((telemetryError: unknown) => {
      process.emitWarning(`Doom-task could not record a narration failure: ${String(telemetryError)}`);
    });
  };
  const narrationSink: TaskNarrationSink = {
    narrate(text) {
      const service = narrationService;
      const request = createNarrationRequest(text);
      if (!service || !request) return;
      try {
        void Promise.resolve(service.request(request)).catch(reportNarrationFailure);
      } catch (error) {
        reportNarrationFailure(error);
      }
    },
  };

  cordis.inject([DOOM_NARRATION_SERVICE], (serviceContext) => {
    const service = requireDoomNarrationService(serviceContext);
    narrationService = service;
    return () => {
      if (narrationService === service) narrationService = undefined;
    };
  });

  const waitForSessionReadiness = async (
    context: { readonly sessionManager: object },
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const current = sessionInitialization;
    if (!current) throw new Error('doom-task session initialization has not started');
    if (current.sessionManager !== context.sessionManager) {
      throw new Error('doom-task readiness belongs to a stale Pi session');
    }
    await current.operation;
    signal?.throwIfAborted();
    if (!active || current !== sessionInitialization || !sessionId) {
      throw new Error('doom-task readiness belongs to a stale extension generation');
    }
  };

  const clearSessionResources = (): void => {
    unwatch?.();
    unwatch = undefined;
    backgroundWorkEnabled = false;
    backgroundWork?.update();
    delegation?.reset();
    overlay?.dispose();
    sessionId = undefined;
  };

  cordis.effect(
    () => async () => {
      active = false;
      sessionGeneration += 1;
      const pendingInitialization = sessionInitialization?.operation;
      sessionInitialization = undefined;
      try {
        if (pendingInitialization) await Promise.allSettled([pendingInitialization]);
        clearSessionResources();
        delegation?.dispose();
        disposeLeader?.();
        disposeLeader = undefined;
        store?.dispose();
      } finally {
        await errorReporter.shutdown();
      }
    },
    LEADER_SOURCE,
  );

  const taskStore = new TaskStore({
    report,
    onCommitted: (previous, committed) => narrateTaskCommit(narrationSink, previous, committed),
  });
  store = taskStore;

  cordis.inject([DOOM_CONTEXT_CONTRIBUTIONS_SERVICE], (contextContributionsContext) => {
    const registration = requireDoomContextContributions(contextContributionsContext).register(
      createTaskContextContribution(() => taskStore.snapshot.tasks),
    );
    return () => registration.dispose();
  });

  const refresh = (): void => {
    if (!active) return;
    overlay?.update();
    backgroundWork?.update();
  };

  const delegationManager = new DelegationManager({
    store: taskStore,
    cwd: process.cwd(),
    platform: createNodeDelegationPlatform(),
    notify: (message, options) => pi.sendMessage(message, options),
    getSessionId: () => sessionId,
    onChange: refresh,
    runTimeoutMs: getDelegationTimeoutMs(),
    report,
    onNotifyError: (error, taskId) => {
      void errorReporter.recordNotificationError(error, taskId);
    },
  });
  delegation = delegationManager;

  cordis.inject([DOOM_DELEGATION_SERVICE], (serviceContext) => {
    const service = readDoomDelegationService(serviceContext);
    if (!service) return undefined;
    return delegationManager.bind(serviceContext, service);
  });

  cordis.inject([DOOM_BACKGROUND_WORK_SERVICE], (serviceContext) => {
    const service = readDoomBackgroundWorkService(serviceContext);
    if (!service) return undefined;
    const handle = service.register({
      provider: BACKGROUND_WORK_PROVIDER,
      listActiveWork: () => (backgroundWorkEnabled ? delegationManager.listActiveWork() : []),
    });
    backgroundWork = handle;
    return () => {
      handle.dispose();
      if (backgroundWork === handle) backgroundWork = undefined;
    };
  });

  const taskOverlay = new TaskOverlay({ getTasks: () => taskStore.snapshot.tasks, delegation: delegationManager });
  overlay = taskOverlay;

  registerTaskTool(pi, {
    store: taskStore,
    delegation: delegationManager,
    maxTasks: getMaxTasks(),
    onChange: refresh,
    report,
    waitUntilReady: waitForSessionReadiness,
  });
  registerTasksCommand(pi, taskStore, waitForSessionReadiness);

  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const contribution = requireDoomUiHub(uiContext).registerLeader({
      source: LEADER_SOURCE,
      bindings: [
        {
          id: 'tasks.open',
          path: [
            { key: 't', label: 'tasks', detail: 'session task list', order: LEADER_GROUP_ORDER },
            { key: 'l', label: 'list', detail: 'tasks in this session' },
          ],
          command: { name: COMMAND_NAME },
        },
      ],
    });
    const dispose = (): void => contribution.dispose();
    disposeLeader = dispose;
    return () => {
      dispose();
      if (disposeLeader === dispose) disposeLeader = undefined;
    };
  });

  pi.registerMessageRenderer(NOTIFY_CUSTOM_TYPE, (message, _options, theme) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return new Text(theme.fg('muted', content), 0, 0);
  });

  const collapseKey = resolveCollapseKey();
  if (collapseKey !== COLLAPSE_KEY_OFF) {
    pi.registerShortcut(collapseKey as KeyId, {
      description: 'Collapse or expand the task overlay',
      handler: async (ctx) => {
        if (!active || !ctx.hasUI) return;
        await waitForSessionReadiness(ctx);
        if (!active || !taskOverlay.isRegistered()) return;
        taskOverlay.toggleCollapse();
      },
    });
  }

  pi.on(SESSION_START_EVENT, async (_event, ctx) => {
    if (!active) return;
    const ownGeneration = ++sessionGeneration;
    if (sessionId !== undefined) clearSessionResources();
    const context = ctx as unknown as SessionContextLike;
    const initialize = async (signal?: AbortSignal): Promise<void> => {
      const isCurrent = (): boolean => !signal?.aborted && active && ownGeneration === sessionGeneration;
      try {
        const currentSessionId = context.sessionManager?.getSessionId();
        if (!currentSessionId) throw new Error('doom-task requires a session id');
        sessionId = currentSessionId;
        backgroundWorkEnabled = !context.hasUI;
        backgroundWork?.update();
        taskStore.configureSession(resolveSessionKey(currentSessionId));
        const cleanup = await removeLegacyStoreDirectoryAsync(taskStore.storePath);
        if (!isCurrent()) return;
        const sweep = hasStorePathOverride()
          ? { removed: [], errors: [] }
          : await sweepStoreFilesAsync(taskStore.storePath, getStoreTtlMs());
        if (!isCurrent()) return;
        const storeErrors = [...cleanup.errors, ...sweep.errors];
        for (const failure of storeErrors) report.warn(TASK_EVENT.storeSweepFailed, new Error(failure));
        if (storeErrors.length > 0 && context.hasUI) context.ui.notify(storeErrors.join('\n'), 'warning');
        if (context.hasUI) taskOverlay.setUICtx(context.ui);
        await taskStore.readAsync(isCurrent);
        if (!isCurrent()) return;
        unwatch = taskStore.onExternalChange(refresh);
        await delegationManager.reconcile(isCurrent);
        if (!isCurrent()) return;
        refresh();
      } catch (error) {
        if (!isCurrent()) return;
        clearSessionResources();
        report.error(TASK_EVENT.sessionStartFailed, error);
        throw error;
      }
    };

    const coordinator = readDoomReadinessCoordinator(cordis);
    if (!coordinator) {
      const operation = initialize();
      sessionInitialization = { sessionManager: ctx.sessionManager, operation };
      return operation;
    }

    const previous = sessionInitialization?.operation;
    const operation = (async (): Promise<void> => {
      if (previous) await Promise.allSettled([previous]);
      if (!active || ownGeneration !== sessionGeneration) return;
      const handle = coordinator.start(
        LEADER_SOURCE,
        `${ctx.sessionManager.getSessionId()}:${ownGeneration}`,
        async (signal) => {
          await initialize(signal);
          return { value: undefined };
        },
      );
      await handle.wait();
    })();
    sessionInitialization = { sessionManager: ctx.sessionManager, operation };
    // Config's coordinator owns the single failure notification. This detached
    // observer only keeps a failed background generation from going unhandled.
    void Promise.allSettled([operation]);
    return undefined;
  });

  pi.on(SESSION_COMPACT_EVENT, refresh);
  pi.on(SESSION_TREE_EVENT, refresh);
  pi.on(TOOL_EXECUTION_END_EVENT, (event) => {
    if (active && event.toolName === TOOL_NAME) refresh();
  });
}

/** The package's single standard Pi factory. */
export async function taskExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, LEADER_SOURCE);
  const fiber = connection.root.plugin(taskPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

interface TaskPluginConfig {
  readonly pi: ExtensionAPI;
}

function taskPlugin(cordis: Context, config: TaskPluginConfig): void {
  installTaskRuntime(cordis, config.pi);
}

export default taskExtension;
