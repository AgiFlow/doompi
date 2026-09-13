import {
  type BackgroundProviderWorkItem,
  type BackgroundWorkProviderHandle,
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/background-work';
import { resolveRootSessionId } from '@agimon-ai/doompi-core/child-process';
import type { DoomFooterContributionHandle } from '@agimon-ai/doompi-core/footer';
import {
  createDoomReadinessCoordinator,
  type DoomReadinessCoordinator,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-core/readiness';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/ui-hub';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  BACKGROUND_WORK_PROVIDER,
  COMPLETED_STATE,
  ERR_REQUIRES_INTERACTIVE,
  ERR_START_USAGE,
  ERR_STOP_USAGE,
  HISTORY_SWEEP_INTERVAL_MS,
  LEADER_GROUP_ORDER,
  LEADER_SOURCE,
  RMUX_BACKEND,
  RUNNER_FINISHED_MESSAGE,
  RUNNER_FOOTER_ORDER,
  RUNNER_STATUS_KEY,
  RUNNER_STATUS_POLL_MS,
  SESSION_START_EVENT,
  STOPPED_REASON,
} from '../constants/runnerRuntime';
import { COMMAND_DESCRIPTION, COMMAND_NAME } from '../constants/runners';
import { RUNNER_SETTINGS_FILE } from '../constants/runnerSettings';
import { createRunnerCompactionRecovery } from '../services/compaction';
import { summarizeLog } from '../services/logReader';
import { cleanupLegacyRunnerStore, reconcileActiveRunners, stopRunnerProcess } from '../services/reconcile';
import { getLogTtlMs } from '../services/runnerConfig';
import { setRunnerSettings } from '../services/runnerConfig';
import { createRunnerDependencies } from '../services/runnerDependencies';
import type { RunnerDependencies } from '../services/runnerDependencies/type';
import { parseRunnersCommand } from '../services/runnersCommand';
import { RunnerSettingsLoader } from '../services/runnerSettings';
import type { IBashRunService } from '../types/bashRunService';
import type { RunnerRecord } from '../types/runnerRegistry';
/** After doom-task's `t` (65) and before the core help group (70). */
import { formatRunnerFooterContribution, formatRunnerStatus } from './format';
import type { RunnerRuntime } from './runnerRuntimeType';
import { openRunnerSpace } from './runnerSpace';

/**
 * How often a live session revisits its own runner history. Retention only
 * bounds a session that ends; a session open all day has to sweep itself.
 */

/**
 * Project-local extension config, read the way Pi documents it: one JSON file
 * per extension under the config directory, and only for a trusted project.
 */
function loadRunnerSettings(context: ExtensionContext): void {
  try {
    const trusted = context.isProjectTrusted?.() ?? false;
    const { settings, issues } = new RunnerSettingsLoader().load(context.cwd, trusted);
    setRunnerSettings(settings);
    // A rejected key is surfaced rather than dropped: silence reads as a
    // setting that simply does not work.
    for (const issue of issues) process.emitWarning(`${RUNNER_SETTINGS_FILE}: ${issue}`);
  } catch (error) {
    process.emitWarning(`Could not read ${RUNNER_SETTINGS_FILE}: ${String(error)}`);
    setRunnerSettings({});
  }
}

/**
 * doom-runner: replaces pi's `bash` tool with a supervised one and provides a
 * CLI for anything it leaves running.
 */
export function createRunnerRuntime(pi: ExtensionAPI): RunnerRuntime {
  let cordis: Context | undefined;
  let initialized = false;
  const environment = Object.freeze({ ...process.env });
  const container = createRunnerDependencies({ environment });
  let registry!: RunnerDependencies['runnerRegistry'];
  let launcher!: RunnerDependencies['launcher'];
  let rmuxBackend!: RunnerDependencies['rmuxBackend'];
  let logReader!: RunnerDependencies['logReader'];
  let ptyHost!: RunnerDependencies['ptyHost'];
  let bashRunService!: RunnerDependencies['bashRunService'];
  let paths!: RunnerDependencies['paths'];
  let processControl!: RunnerDependencies['processControl'];
  let lifeline!: RunnerDependencies['lifeline'];

  let active = true;
  let sessionGeneration = 0;
  let sessionId: string | undefined;
  let rootSessionId: string | undefined;
  let runners: RunnerRecord[] = [];
  let sessionContext: ExtensionContext | undefined;
  let footerContribution: DoomFooterContributionHandle | undefined;
  let telemetry: DoomTelemetry | undefined;
  let sessionReady = false;
  let disposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let historySweepInFlight: Promise<void> | undefined;
  let historySweepTimer: ReturnType<typeof setImmediate> | undefined;
  let statusPoll: ReturnType<typeof setInterval> | undefined;
  let historySweepPoll: ReturnType<typeof setInterval> | undefined;
  let unsubscribeRegistry: (() => void) | undefined;
  let sessionInitialization: Promise<void> = Promise.resolve();
  let fallbackReadiness: DoomReadinessCoordinator | undefined;
  let refreshQueued = false;
  let queuedReconciliation = false;
  let lastRunnerCount: number | undefined;
  const notifiedRunnerIds = new Set<string>();
  const pendingPromotedRunnerIds = new Set<string>();
  const terminalRunners = new Map<string, RunnerRecord>();
  let backgroundWorkItems: BackgroundProviderWorkItem[] = [];
  let backgroundWorkProvider: BackgroundWorkProviderHandle | undefined;
  const pendingOperations = new Set<Promise<unknown>>();
  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    pendingOperations.add(operation);
    void operation.then(
      () => pendingOperations.delete(operation),
      () => pendingOperations.delete(operation),
    );
    return operation;
  };
  const waitForSessionReadiness = async (): Promise<void> => {
    await sessionInitialization;
    if (!active || !sessionReady || !sessionId) {
      throw new Error('doom-runner requires an active Pi session');
    }
  };
  const trackedBashRunService: IBashRunService = {
    run: async (request) => {
      await waitForSessionReadiness();
      return trackOperation(bashRunService.run(request));
    },
  };
  const isCurrent = (generation: number, expectedSessionId = sessionId): boolean =>
    active && !disposed && generation === sessionGeneration && expectedSessionId === sessionId;
  const getTelemetry = (ctx: ExtensionContext): DoomTelemetry => {
    telemetry ??= createDoomTelemetry({
      serviceName: 'doom-runner',
      packageName: '@agimon-ai/doompi-runner',
      cwd: ctx.cwd,
      env: environment,
      enableLogs: true,
      enableTraces: true,
    });
    return telemetry;
  };
  const publishBackgroundWork = (): void => {
    const activeSessionId = sessionId;
    const representedIds = new Set([...runners.map((record) => record.id), ...terminalRunners.keys()]);
    const next = activeSessionId
      ? [
          ...runners
            .filter((record) => record.sessionId === activeSessionId && record.promoted)
            .map((record) => ({
              id: record.id,
              sessionId: record.sessionId,
              label: record.name,
              status: record.state,
            })),
          ...[...terminalRunners.values()]
            .filter((record) => record.sessionId === activeSessionId)
            .map((record) => ({
              id: record.id,
              sessionId: record.sessionId,
              label: record.name,
              status: record.state,
            })),
          ...[...pendingPromotedRunnerIds]
            .filter((id) => !representedIds.has(id))
            .map((id) => ({ id, sessionId: activeSessionId, status: 'running' })),
        ]
      : [];
    if (JSON.stringify(next) === JSON.stringify(backgroundWorkItems)) return;
    backgroundWorkItems = next;
    backgroundWorkProvider?.update();
  };
  /** Performs one bounded pass over active state and explicitly monitored runners. */
  const refreshNow = async (shouldReconcile: boolean): Promise<void> => {
    const activeSessionId = sessionId;
    const generation = sessionGeneration;
    if (!activeSessionId || !isCurrent(generation, activeSessionId)) return;

    const activeRecords = await registry.list();
    if (!isCurrent(generation, activeSessionId)) return;
    let visibleActive = activeRecords;
    if (shouldReconcile) {
      const reconciled = await reconcileActiveRunners({
        registry,
        launcher,
        rmuxBackend,
        processControl,
        currentHostPid: process.pid,
        startup: false,
        active: activeRecords,
      });
      for (const error of reconciled.errors) process.emitWarning(error);
      if (reconciled.reclaimed.length > 0) {
        const reclaimedIds = new Set(reconciled.reclaimed);
        visibleActive = activeRecords.filter((record) => !reclaimedIds.has(record.id));
      }
    }
    if (!isCurrent(generation, activeSessionId)) return;

    runners = visibleActive.filter((record) => record.sessionId === activeSessionId);
    const rootRunners = rootSessionId
      ? visibleActive.filter((record) => (record.rootSessionId ?? record.sessionId) === rootSessionId)
      : [];
    const runnerCount = rootRunners.length;
    if (lastRunnerCount !== runnerCount) {
      lastRunnerCount = runnerCount;
      footerContribution?.update(formatRunnerFooterContribution(runnerCount));
      if (sessionContext?.hasUI) sessionContext.ui.setStatus(RUNNER_STATUS_KEY, formatRunnerStatus(runnerCount));
    }

    const pendingIds = [...pendingPromotedRunnerIds];
    const monitored = await Promise.all(pendingIds.map((id) => registry.get(id, activeSessionId)));
    if (!isCurrent(generation, activeSessionId)) return;
    for (const [index, record] of monitored.entries()) {
      const id = pendingIds[index];
      if (!id) continue;
      if (!record || record.sessionId !== activeSessionId) {
        pendingPromotedRunnerIds.delete(id);
        terminalRunners.delete(id);
        runners = runners.filter((candidate) => candidate.id !== id);
        continue;
      }
      if (record.state === COMPLETED_STATE) {
        runners = runners.filter((candidate) => candidate.id !== record.id);
        terminalRunners.set(record.id, record);
      }
    }
    publishBackgroundWork();
    for (const record of monitored) {
      if (!record || record.sessionId !== activeSessionId || record.state !== COMPLETED_STATE) continue;
      if (notifiedRunnerIds.has(record.id)) continue;
      const outcome = record.exit?.reason ?? COMPLETED_STATE;
      const code =
        record.exit?.code === null || record.exit?.code === undefined ? '' : `, exit code ${record.exit.code}`;
      const content = [
        `Background runner ${record.name} exited: ${outcome}${code}.`,
        `Runner ID: ${record.id}`,
        `Log: ${record.logPath}`,
        `Inspect: doom-runner logs ${record.id}`,
      ].join('\n');
      pi.sendMessage(
        { customType: RUNNER_FINISHED_MESSAGE, content, display: true },
        { triggerTurn: true, deliverAs: 'steer' },
      );
      notifiedRunnerIds.add(record.id);
      pendingPromotedRunnerIds.delete(record.id);
      terminalRunners.delete(record.id);
      publishBackgroundWork();
      if (sessionContext) {
        void trackOperation(
          getTelemetry(sessionContext).recordEvent('doom_runner.process_finished', {
            outcome: 'completed',
            'runner.exit_code': record.exit?.code ?? 0,
            'runner.backend': record.backend,
            ...(Number.isFinite(Date.parse(record.startedAt))
              ? { duration_ms: Math.max(0, Date.now() - Date.parse(record.startedAt)) }
              : {}),
          }),
        );
      }
    }
  };

  /** Coalesces timer and event triggers without losing a requested reconciliation pass. */
  const refresh = (shouldReconcile = true): Promise<void> => {
    if (!sessionId || !sessionReady || disposed) return Promise.resolve();
    if (refreshInFlight) {
      refreshQueued = true;
      queuedReconciliation ||= shouldReconcile;
      return refreshInFlight;
    }

    const execution = (async () => {
      let reconcileNext = shouldReconcile;
      do {
        refreshQueued = false;
        queuedReconciliation = false;
        await refreshNow(reconcileNext);
        reconcileNext = queuedReconciliation;
      } while (refreshQueued && !disposed);
    })().finally(() => {
      if (refreshInFlight === execution) refreshInFlight = undefined;
    });
    refreshInFlight = execution;
    return execution;
  };

  const reportRefreshError = (error: unknown): void => {
    if (disposed) return;
    if (sessionContext) {
      void trackOperation(getTelemetry(sessionContext).recordError('doom_runner.refresh_failed', error));
    }
    process.emitWarning(`Could not refresh doom-runner: ${String(error)}`);
  };
  const scheduleRefresh = (shouldReconcile: boolean): void => {
    void refresh(shouldReconcile).catch(reportRefreshError);
  };
  const scheduleHistorySweep = (): void => {
    if (historySweepTimer || historySweepInFlight || disposed) return;
    historySweepTimer = setImmediate(() => {
      historySweepTimer = undefined;
      if (disposed) return;
      const execution = (async () => {
        const sweep = paths.sweepHistoryAsync
          ? await paths.sweepHistoryAsync(getLogTtlMs())
          : paths.sweepHistory(getLogTtlMs());
        for (const error of sweep.errors) process.emitWarning(error);
      })()
        .catch((error) => process.emitWarning(`Could not sweep doom-runner history: ${String(error)}`))
        .finally(() => {
          if (historySweepInFlight === execution) historySweepInFlight = undefined;
        });
      historySweepInFlight = execution;
    });
    historySweepTimer.unref?.();
  };

  const runCleanup = async (label: string, cleanup: () => void | Promise<void>): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      process.emitWarning(`Doom-runner cleanup could not ${label}: ${String(error)}`);
    }
  };

  const shutdownRuntime = async (): Promise<void> => {
    if (disposed) return;
    active = false;
    disposed = true;
    sessionGeneration += 1;
    sessionReady = false;
    if (statusPoll) clearInterval(statusPoll);
    statusPoll = undefined;
    if (historySweepPoll) clearInterval(historySweepPoll);
    historySweepPoll = undefined;
    if (historySweepTimer) clearImmediate(historySweepTimer);
    historySweepTimer = undefined;
    const unsubscribe = unsubscribeRegistry;
    unsubscribeRegistry = undefined;
    if (unsubscribe) await runCleanup('unsubscribe from the runner registry', unsubscribe);

    const ownedReadiness = fallbackReadiness;
    fallbackReadiness = undefined;
    if (ownedReadiness) await runCleanup('cancel standalone readiness work', () => ownedReadiness.dispose());
    await Promise.allSettled(pendingOperations);
    const activeRefresh = refreshInFlight;
    if (activeRefresh) await runCleanup('settle the runner refresh', () => activeRefresh);
    const activeHistorySweep = historySweepInFlight;
    if (activeHistorySweep) await runCleanup('settle runner history cleanup', () => activeHistorySweep);

    await runCleanup('dispose runner PTYs', () => ptyHost.disposeAll());

    let owned: RunnerRecord[] = [];
    if (sessionId) {
      try {
        owned = await registry.listBySession(sessionId);
      } catch (error) {
        process.emitWarning(`Could not list runners during doom-runner shutdown: ${String(error)}`);
      }
    }
    await Promise.all(
      owned.map(async (record) => {
        try {
          const stopped = await stopRunnerProcess(record, launcher, rmuxBackend);
          if (!stopped && processControl.isAlive(record.pid)) {
            process.emitWarning(`Could not stop runner ${record.id} during session shutdown`);
            return;
          }
          await registry.complete(
            record.id,
            {
              reason: STOPPED_REASON,
              code: null,
              signal: stopped ? 'SIGTERM' : null,
              stopReason: 'session ended',
            },
            record.sessionId,
          );
        } catch (error) {
          process.emitWarning(`Could not clean up runner ${record.id}: ${String(error)}`);
        }
      }),
    );

    const context = sessionContext;
    const ownedTelemetry = telemetry;
    telemetry = undefined;
    sessionContext = undefined;
    sessionId = undefined;
    rootSessionId = undefined;
    runners = [];
    notifiedRunnerIds.clear();
    pendingPromotedRunnerIds.clear();
    terminalRunners.clear();
    publishBackgroundWork();

    await Promise.all([
      runCleanup('dispose the runner lifeline', () => lifeline.dispose()),
      ...(context?.hasUI
        ? [runCleanup('clear the runner status', () => context.ui.setStatus(RUNNER_STATUS_KEY, undefined))]
        : []),
    ]);
    await runCleanup('close the runner registry', () => registry.close());
    if (ownedTelemetry) {
      await runCleanup('record the runner session finish', () =>
        ownedTelemetry.recordEvent('doom_runner.session_finished', { outcome: 'stopped' }),
      );
      await runCleanup('stop runner telemetry', () => ownedTelemetry.shutdown());
    }
  };

  /** Stops one of this session's runners; false when no such runner is active. */
  const stopSessionRunner = async (
    generation: number,
    activeSessionId: string,
    id: string,
    reason?: string,
  ): Promise<boolean> => {
    if (!isCurrent(generation, activeSessionId)) return false;
    const record = runners.find((candidate) => candidate.id === id);
    if (!record) return false;
    if (record.backend === RMUX_BACKEND && record.backendTarget) {
      await rmuxBackend.stop(record.backendTarget, record.pid);
    } else await launcher.stop(record.pid);
    if (!isCurrent(generation, activeSessionId)) return true;
    await registry.complete(
      record.id,
      { reason: STOPPED_REASON, code: null, signal: null, stopReason: reason },
      record.sessionId,
    );
    if (isCurrent(generation, activeSessionId)) await refresh();
    return true;
  };

  return {
    events: {
      session_compact: createRunnerCompactionRecovery(pi, {
        getSessionId: async () => {
          try {
            await waitForSessionReadiness();
            return sessionId;
          } catch {
            return undefined;
          }
        },
        listBySession: async (activeSessionId) => {
          try {
            await waitForSessionReadiness();
          } catch {
            return [];
          }
          return active ? registry.listBySession(activeSessionId) : [];
        },
      }),

      [SESSION_START_EVENT]: (_event, ctx) => {
        if (!active) return;
        const context = ctx as ExtensionContext;
        loadRunnerSettings(context);
        const activeSessionId = context.sessionManager.getSessionId();
        const previousSessionId = sessionId;
        const previousContext = sessionContext;
        const generation = ++sessionGeneration;
        sessionId = activeSessionId;
        rootSessionId = resolveRootSessionId(activeSessionId, environment);
        sessionContext = context;
        sessionReady = false;
        lastRunnerCount = undefined;
        runners = [];
        notifiedRunnerIds.clear();
        pendingPromotedRunnerIds.clear();
        terminalRunners.clear();
        publishBackgroundWork();

        const initializeSession = async (signal: AbortSignal): Promise<readonly string[]> => {
          const stillCurrent = (): boolean => !signal.aborted && isCurrent(generation, activeSessionId);
          if (!stillCurrent()) return [];
          if (previousSessionId && previousSessionId !== activeSessionId) {
            await runCleanup('dispose the previous session PTYs', () => ptyHost.disposeAll());
            await runCleanup('dispose the previous session lifeline', () => lifeline.dispose());
            if (previousContext?.hasUI) {
              await runCleanup('clear the previous session status', () =>
                previousContext.ui.setStatus(RUNNER_STATUS_KEY, undefined),
              );
            }
            const previousTelemetry = telemetry;
            telemetry = undefined;
            if (previousTelemetry) {
              await runCleanup('stop the previous session telemetry', () => previousTelemetry.shutdown());
            }
            if (!stillCurrent()) return [];
          }

          const activeTelemetry = getTelemetry(context);
          await activeTelemetry.recordEvent('doom_runner.session_started', { outcome: 'started' });
          if (!stillCurrent()) return [];
          paths.setSessionId(activeSessionId);
          // Awaited before anything can launch, so every runner this session starts
          // finds a lifeline it can connect to rather than a socket that is not
          // listening yet, which would read as an owner that is already gone.
          await lifeline.arm(activeSessionId);
          if (!stillCurrent()) return [];

          const retained = await registry.listAll(activeSessionId);
          if (!stillCurrent()) return [];
          for (const record of retained) {
            if (record.state === COMPLETED_STATE) notifiedRunnerIds.add(record.id);
            else if (record.promoted) pendingPromotedRunnerIds.add(record.id);
          }
          const legacy = await cleanupLegacyRunnerStore({
            registry,
            launcher,
            rmuxBackend,
            processControl,
            currentHostPid: process.pid,
            paths,
          });
          if (!stillCurrent()) return [];
          const reconciled = await reconcileActiveRunners({
            registry,
            launcher,
            rmuxBackend,
            processControl,
            currentHostPid: process.pid,
            startup: true,
          });
          if (!stillCurrent()) return [];
          sessionReady = true;
          await refresh(false);
          if (!stillCurrent()) return [];
          scheduleHistorySweep();
          const errors = [...legacy.errors, ...reconciled.errors];
          const reclaimedCount = legacy.reclaimed.length + reconciled.reclaimed.length;
          if (reclaimedCount > 0 && context.hasUI) {
            context.ui.notify(`Reclaimed ${reclaimedCount} stale runner record(s)`, 'warning');
          }
          await activeTelemetry.recordEvent('doom_runner.reconciled', {
            'runner.reclaimed_count': reclaimedCount,
            'runner.error_count': errors.length,
            outcome: errors.length === 0 ? 'completed' : 'degraded',
          });
          return errors;
        };

        const previousInitialization = sessionInitialization.catch(() => undefined);
        const startReadiness = async (): Promise<void> => {
          await previousInitialization;
          if (!isCurrent(generation, activeSessionId)) return;
          const coordinator =
            (cordis ? readDoomReadinessCoordinator(cordis) : undefined) ??
            (fallbackReadiness ??= createDoomReadinessCoordinator({
              notify: (notification) => {
                process.emitWarning(
                  `${notification.packageId} initialization ${notification.state}: ${notification.error?.message ?? notification.diagnostics.join('; ')}`,
                );
              },
            }));
          const handle = coordinator.start(LEADER_SOURCE, `${activeSessionId}:${generation}`, async (signal) => ({
            value: undefined,
            diagnostics: await initializeSession(signal),
          }));
          await handle.wait();
        };
        const operation = startReadiness();
        sessionInitialization = operation;
        // The coordinator reports a failed generation once; this branch only marks
        // the detached waiter handled so Pi is not held open by the notification path.
        void trackOperation(operation).catch(() => undefined);
      },
    },
    command: [
      COMMAND_NAME,
      {
        description: COMMAND_DESCRIPTION,
        handler: async (args, ctx) => {
          if (!active) return;
          const generation = sessionGeneration;
          const activeSessionId = sessionId;
          if (!activeSessionId) return;
          const request = parseRunnersCommand(args);
          // The stop verb is how a client without an overlay (the web cockpit)
          // controls a runner, so it must not need the interactive UI.
          if (request.kind === 'stop') {
            if (!request.id) {
              ctx.ui.notify(ERR_STOP_USAGE, 'error');
              return;
            }
            await waitForSessionReadiness();
            await refresh();
            if (!isCurrent(generation, activeSessionId)) return;
            const stopped = await stopSessionRunner(generation, activeSessionId, request.id, request.reason);
            if (!isCurrent(generation, activeSessionId)) return;
            if (stopped) ctx.ui.notify(`Stopped runner ${request.id}.`, 'info');
            else ctx.ui.notify(`No active runner ${request.id} in this session.`, 'error');
            return;
          }
          // Starting headlessly is how a client without the bash tool (the web
          // cockpit) puts a command up. It is background by construction: a
          // foreground wait has nobody here to wait for it.
          if (request.kind === 'start') {
            if (!request.command) {
              ctx.ui.notify(ERR_START_USAGE, 'error');
              return;
            }
            await waitForSessionReadiness();
            if (!isCurrent(generation, activeSessionId)) return;
            const started = await trackedBashRunService.run({
              command: request.command,
              sessionId: activeSessionId,
              background: true,
              ...(request.cwd ? { cwd: request.cwd } : {}),
              ...(request.name ? { name: request.name } : {}),
              ...(request.interactive ? { interactive: true } : {}),
            });
            if (!isCurrent(generation, activeSessionId)) return;
            await refresh();
            if (started.kind === 'failed') ctx.ui.notify(`Could not start a runner: ${started.error}`, 'error');
            else ctx.ui.notify(`Started runner ${started.name}.`, 'info');
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify(ERR_REQUIRES_INTERACTIVE, 'error');
            return;
          }
          await waitForSessionReadiness();
          await refresh();
          if (!activeSessionId || !isCurrent(generation, activeSessionId)) return;
          await openRunnerSpace(ctx, {
            getRunners: () => (isCurrent(generation, activeSessionId) ? runners : []),
            getPtyRun: (name) =>
              isCurrent(generation, activeSessionId) ? (rmuxBackend.get(name) ?? ptyHost.get(name)) : undefined,
            readLog: (logPath) =>
              isCurrent(generation, activeSessionId) ? logReader.read(logPath, { lines: 1_000 }).text : '',
            stopRunner: async (id, reason) => {
              await stopSessionRunner(generation, activeSessionId, id, reason);
            },
          });
        },
      },
    ],
    bashTool: {
      bashRunService: trackedBashRunService,
      getSessionId: async () => {
        await waitForSessionReadiness();
        if (!sessionId) throw new Error('doom-runner requires an active Pi session');
        return sessionId;
      },
      onRunnerStarted: (id) => {
        if (!active || !sessionReady) return;
        pendingPromotedRunnerIds.add(id);
        publishBackgroundWork();
        scheduleRefresh(false);
      },
      summarizeLog,
    },
    plugin(context) {
      cordis = context;
      context.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
        const contribution = requireDoomUiHub(uiContext).registerFooter({
          source: LEADER_SOURCE,
          id: 'runner-count',
          order: RUNNER_FOOTER_ORDER,
        });
        footerContribution = contribution;
        return () => {
          contribution.dispose();
          if (footerContribution === contribution) footerContribution = undefined;
        };
      });
      context.inject([DOOM_BACKGROUND_WORK_SERVICE], (serviceContext) => {
        const service = readDoomBackgroundWorkService(serviceContext);
        if (!service) return undefined;
        const registration = service.register({
          provider: BACKGROUND_WORK_PROVIDER,
          listActiveWork: () => backgroundWorkItems,
        });
        backgroundWorkProvider = registration;
        return () => {
          registration.dispose();
          if (backgroundWorkProvider === registration) backgroundWorkProvider = undefined;
        };
      });
      context.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
        const contribution = requireDoomUiHub(uiContext).registerLeader({
          source: LEADER_SOURCE,
          bindings: [
            {
              id: 'runners.open',
              path: [
                { key: 'r', label: 'runners', detail: 'background processes', order: LEADER_GROUP_ORDER },
                { key: 'l', label: 'list', detail: 'runners in this session' },
              ],
              command: { name: COMMAND_NAME },
            },
          ],
        });
        return () => contribution.dispose();
      });
    },
    start() {
      registry = container.runnerRegistry;
      launcher = container.launcher;
      rmuxBackend = container.rmuxBackend;
      logReader = container.logReader;
      ptyHost = container.ptyHost;
      bashRunService = container.bashRunService;
      paths = container.paths;
      processControl = container.processControl;
      lifeline = container.lifeline;
      initialized = true;
      unsubscribeRegistry = registry.subscribe(() => scheduleRefresh(false));
      statusPoll = setInterval(() => scheduleRefresh(true), RUNNER_STATUS_POLL_MS);
      statusPoll.unref?.();
      historySweepPoll = setInterval(() => scheduleHistorySweep(), HISTORY_SWEEP_INTERVAL_MS);
      historySweepPoll.unref?.();
    },
    async stop() {
      if (initialized) await shutdownRuntime();
      else registry?.close();
      cordis = undefined;
    },
  };
}
