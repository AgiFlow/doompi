import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type BackgroundWorkProviderHandle,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/background-work';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  requireDoomContextContributions,
} from '@agimon-ai/doompi-core/context-contributions';
import { DOOM_DELEGATION_SERVICE, readDoomDelegationService } from '@agimon-ai/doompi-core/delegation';
import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import {
  createNarrationRequest,
  DOOM_NARRATION_SERVICE,
  type DoomNarrationService,
  requireDoomNarrationService,
} from '@agimon-ai/doompi-core/narration';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import { readDoomReadinessCoordinator } from '@agimon-ai/doompi-core/readiness';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import type { Task } from '../../../../../models/task';
import { COMMAND_NAME, TOOL_NAME } from '../../../../../schemas/task';
import { getDelegationTimeoutMs, getMaxTasks, getStoreTtlMs } from '../../../../../services/config';
import {
  createTaskContextContribution,
  TASK_CONTEXT_CONTRIBUTION_SOURCE,
} from '../../../../../services/contextContribution';
import { BACKGROUND_WORK_PROVIDER, DelegationManager } from '../../../../../services/delegation';
import { createNodeDelegationPlatform } from '../../../../../services/delegationPlatform';
import { createTaskErrorReporter, TASK_EVENT, toFailureReporter } from '../../../../../services/logSinkTelemetry';
import {
  hasStorePathOverride,
  removeLegacyStoreDirectoryAsync,
  resolveSessionKey,
  sweepStoreFilesAsync,
} from '../../../../../services/paths';
import { narrateTaskCommit, type TaskNarrationSink } from '../../../../../services/taskNarration';
import { TaskStore } from '../../../../../services/taskStore';
import type { TaskToolDependencies } from '../tool/_lib/task.cli';

export interface TaskOverlayContract {
  setUICtx(context: ExtensionUIContext): void;
  update(): void;
  dispose(): void;
  toggleCollapse(): void;
  isRegistered(): boolean;
}

export interface TaskRootPresentation {
  createOverlay(options: { getTasks: () => readonly Task[]; delegation: DelegationManager }): TaskOverlayContract;
  registerCollapseShortcut(
    pi: Pick<ExtensionAPI, 'registerShortcut'>,
    overlay: TaskOverlayContract,
    waitUntilReady: (context: ExtensionContext) => Promise<void>,
    isActive: () => boolean,
  ): void;
}

interface SessionContextLike {
  hasUI: boolean;
  ui: ExtensionUIContext;
  sessionManager?: { getSessionId(): string };
}

const LEADER_SOURCE = TASK_CONTEXT_CONTRIBUTION_SOURCE;
const NARRATION_FAILED_EVENT = 'doom_task.narration_failed';
/** Between doom-plan's 60 and the core help group's 70, so `t` sits after `p`. */
const LEADER_GROUP_ORDER = 65;
const ERROR_TYPE_ATTRIBUTE = 'error.type';
/**
 * Which part of session start ran. The telemetry sanitizer drops free text, so
 * the failing branch has to travel as a stable low-cardinality token.
 */
const SESSION_START_STAGE_ATTRIBUTE = 'task.stage';
const SESSION_START_STAGE = {
  sessionId: 'session_id',
  storeCleanup: 'store_cleanup',
  storeSweep: 'store_sweep',
  storeRead: 'store_read',
  reconcile: 'reconcile',
  refresh: 'refresh',
} as const;
type SessionStartStage = (typeof SESSION_START_STAGE)[keyof typeof SESSION_START_STAGE];

/**
 * Mirror of the telemetry sink's own `error.type` token. The sink overwrites it
 * for any defined error, so this only guarantees the attribute exists when the
 * thrown value is `undefined`.
 */
function errorTypeToken(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  if (typeof error === 'string') return 'StringError';
  if (error && typeof error === 'object') return 'ObjectError';
  return 'UnknownError';
}
/** Install Task state and external resources into its host-owned Cordis plugin fiber. */
const createTaskRootExtension =
  (presentation: TaskRootPresentation) =>
  ({ context: cordis, pi, signal: pluginSignal }: PiPluginContext) => {
    const errorReporter = createTaskErrorReporter();
    const report = toFailureReporter(errorReporter);
    let active = true;
    let sessionGeneration = 0;
    let narrationService: DoomNarrationService | undefined;
    let store: TaskStore | undefined;
    let delegation: DelegationManager | undefined;
    let overlay: TaskOverlayContract | undefined;
    let unwatch: (() => void) | undefined;
    let backgroundWork: BackgroundWorkProviderHandle | undefined;
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
      if (!active || pluginSignal.aborted || current !== sessionInitialization || !sessionId) {
        throw new Error('doom-task readiness belongs to a stale extension generation');
      }
    };

    const clearSessionResources = (): void => {
      unwatch?.();
      unwatch = undefined;
      delegation?.reset();
      overlay?.dispose();
      sessionId = undefined;
    };

    const taskStore = new TaskStore({
      report,
      onCommitted: (previous, committed) => narrateTaskCommit(narrationSink, previous, committed),
    });
    store = taskStore;

    const refresh = (): void => {
      if (!active || pluginSignal.aborted) return;
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

    const taskOverlay = presentation.createOverlay({
      getTasks: () => taskStore.snapshot.tasks,
      delegation: delegationManager,
    });
    overlay = taskOverlay;

    const toolDependencies: TaskToolDependencies = {
      store: taskStore,
      delegation: delegationManager,
      maxTasks: getMaxTasks(),
      onChange: refresh,
      report,
      waitUntilReady: waitForSessionReadiness,
    };

    const sessionStart = async (_event: unknown, ctx: ExtensionContext) => {
      if (!active || pluginSignal.aborted) return;
      const ownGeneration = ++sessionGeneration;
      if (sessionId !== undefined) clearSessionResources();
      const context = ctx as unknown as SessionContextLike;
      const initialize = async (signal?: AbortSignal): Promise<void> => {
        const isCurrent = (): boolean =>
          !signal?.aborted && active && !pluginSignal.aborted && ownGeneration === sessionGeneration;
        let stage: SessionStartStage = SESSION_START_STAGE.sessionId;
        /**
         * Run a stage whose failure only degrades task visibility. The session
         * still starts, and the warning keeps the degraded state from being silent.
         */
        const degrade = async (next: SessionStartStage, operation: () => Promise<void>): Promise<void> => {
          stage = next;
          try {
            await operation();
          } catch (error) {
            report.warn(TASK_EVENT.sessionStartDegraded, error, {
              [SESSION_START_STAGE_ATTRIBUTE]: next,
              [ERROR_TYPE_ATTRIBUTE]: errorTypeToken(error),
            });
          }
        };
        try {
          const currentSessionId = context.sessionManager?.getSessionId();
          if (!currentSessionId) throw new Error('doom-task requires a session id');
          sessionId = currentSessionId;
          taskStore.configureSession(resolveSessionKey(currentSessionId));
          stage = SESSION_START_STAGE.storeCleanup;
          const cleanup = await removeLegacyStoreDirectoryAsync(taskStore.storePath);
          if (!isCurrent()) return;
          stage = SESSION_START_STAGE.storeSweep;
          const sweep = hasStorePathOverride()
            ? { removed: [], errors: [] }
            : await sweepStoreFilesAsync(taskStore.storePath, getStoreTtlMs());
          if (!isCurrent()) return;
          const storeErrors = [...cleanup.errors, ...sweep.errors];
          for (const failure of storeErrors) report.warn(TASK_EVENT.storeSweepFailed, new Error(failure));
          if (storeErrors.length > 0 && context.hasUI) context.ui.notify(storeErrors.join('\n'), 'warning');
          if (context.hasUI) taskOverlay.setUICtx(context.ui);
          await degrade(SESSION_START_STAGE.storeRead, async () => {
            await taskStore.readAsync(isCurrent);
          });
          if (!isCurrent()) return;
          unwatch = taskStore.onExternalChange(refresh);
          await degrade(SESSION_START_STAGE.reconcile, async () => {
            await delegationManager.reconcile(isCurrent);
          });
          if (!isCurrent()) return;
          stage = SESSION_START_STAGE.refresh;
          refresh();
        } catch (error) {
          if (!isCurrent()) return;
          clearSessionResources();
          report.error(TASK_EVENT.sessionStartFailed, error, {
            [SESSION_START_STAGE_ATTRIBUTE]: stage,
            [ERROR_TYPE_ATTRIBUTE]: errorTypeToken(error),
          });
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
        if (!active || pluginSignal.aborted || ownGeneration !== sessionGeneration) return;
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
    };

    const toolExecutionEnd = (event: { toolName: string }) => {
      if (active && !pluginSignal.aborted && event.toolName === TOOL_NAME) refresh();
    };
    const dispose = async () => {
      if (!active) return;
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
    };
    return {
      value: {
        taskStore,
        delegationManager,
        taskOverlay,
        toolDependencies,
        waitForSessionReadiness,
        refresh,
        sessionStart,
        toolExecutionEnd,
        isActive: () => active && !pluginSignal.aborted,
      },
      services: [
        (cordis: Context) => {
          cordis.inject([DOOM_NARRATION_SERVICE], (serviceContext) => {
            const service = requireDoomNarrationService(serviceContext);
            narrationService = service;
            return () => {
              if (narrationService === service) narrationService = undefined;
            };
          });
          cordis.inject([DOOM_CONTEXT_CONTRIBUTIONS_SERVICE], (contextContributionsContext) => {
            const registration = requireDoomContextContributions(contextContributionsContext).register(
              createTaskContextContribution(() => taskStore.snapshot.tasks),
            );
            return () => registration.dispose();
          });
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
              listActiveWork: () => delegationManager.listActiveWork(),
            });
            backgroundWork = handle;
            return () => {
              handle.dispose();
              if (backgroundWork === handle) backgroundWork = undefined;
            };
          });
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
        },
      ],
      onStop: dispose,
      onDispose: dispose,
      onStart() {
        presentation.registerCollapseShortcut(
          pi,
          taskOverlay,
          waitForSessionReadiness,
          () => active && !pluginSignal.aborted,
        );
      },
    };
  };
export const createTaskRoot = (presentation: TaskRootPresentation) => defineRoot(createTaskRootExtension(presentation));
export type TaskPiScope = Awaited<ReturnType<ReturnType<typeof createTaskRoot>>>['value'];
