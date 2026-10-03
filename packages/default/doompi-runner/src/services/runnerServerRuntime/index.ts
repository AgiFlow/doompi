import {
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
  type BackgroundProviderWorkItem,
  type BackgroundWorkProviderHandle,
} from '@agimon-ai/doompi-core/backgroundWork';
import type { DoomHeadlessActivity, DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import type { Context } from '@deepseek-ai/cordis';

import { BACKGROUND_WORK_PROVIDER } from '../../constants/runnerRuntime';
import { RUNNER_RUNS_TYPE } from '../../constants/webRunners';
import { reconcileActiveRunners, stopRunnerProcess } from '../reconcile';
import type { RunnerDependencies } from '../runnerDependencies/type';
import { formatRunnerFinished } from '../runnerRecord';
import { presentRunnerRuns } from '../webRunnerRuns';

const COMPLETION_RETRY_MS = 1_000;

export interface RunnerServerRuntime {
  readonly container: RunnerDependencies;
  readonly activity: DoomHeadlessActivity;
  readonly backgroundWorkPlugin: (context: Context) => void;
  ensureSession(sessionId: string): Promise<void>;
  /** Wakes the agent once when this runner, which it sent to the background, exits. */
  watchRunner(id: string): void;
  dispose(this: void): Promise<void>;
}
export function createRunnerServerRuntime(
  container: RunnerDependencies,
  directEvents: NonNullable<DoomServerHostService['context']['directEvents']>,
  /** Absent when no agent runs in this session, so there is nobody to wake. */
  wakeAgent?: (content: string, requestId: string) => Promise<void>,
): RunnerServerRuntime {
  let sessionId: string | undefined;
  let supervision: Promise<void> | undefined;
  let runtimeDisposal: Promise<void> | undefined;
  let backgroundWorkItems: BackgroundProviderWorkItem[] = [];
  let backgroundWorkProvider: BackgroundWorkProviderHandle | undefined;
  // Nothing else tells the model a background runner ended, so without this an
  // agent that finished its turn waiting on one idles until a person prompts it.
  const watched = new Set<string>();
  let unsubscribeWatched: (() => void) | undefined;
  let wakes: Promise<void> = Promise.resolve();
  let closing = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  // The activity is optional and source-gated. The retained facet owns the
  // session runtime, so disabling the activity must not tear down its jobs.
  const ensureSession = (requestedSessionId: string): Promise<void> => {
    if (sessionId !== undefined && sessionId !== requestedSessionId) {
      throw new Error(`Runner runtime belongs to session ${sessionId}.`);
    }
    sessionId ??= requestedSessionId;
    supervision ??= (async () => {
      container.paths.setSessionId(requestedSessionId);
      if ((await container.lifeline.arm(requestedSessionId)) === undefined) {
        throw new Error('Could not arm runner supervision lifeline.');
      }
      const reconciled = await reconcileActiveRunners({
        registry: container.runnerRegistry,
        launcher: container.launcher,
        rmuxBackend: container.rmuxBackend,
        processControl: container.processControl,
        currentHostPid: process.pid,
        startup: true,
      });
      for (const error of reconciled.errors) process.emitWarning(error);
    })();
    return supervision;
  };

  const disposeRuntime = (): Promise<void> => {
    runtimeDisposal ??= (async () => {
      await supervision?.catch((error: unknown) =>
        process.emitWarning(`Could not initialize headless runner supervision: ${String(error)}`),
      );
      const ownedSessionId = sessionId;
      if (ownedSessionId === undefined) return;
      const records = await container.runnerRegistry.listBySession(ownedSessionId).catch(() => []);
      await Promise.all(
        records.map(async (record) => {
          try {
            const stopped = await stopRunnerProcess(record, container.launcher, container.rmuxBackend, {
              registry: container.runnerRegistry,
              intent: {
                reason: 'stopped',
                terminationReason: 'parent_session_cleanup',
                stopReason: 'session ended',
              },
            });
            if (!stopped && container.processControl.isAlive(record.pid)) {
              process.emitWarning(`Could not stop runner ${record.id} during session shutdown`);
              return;
            }
            await container.runnerRegistry.complete(
              record.id,
              { reason: 'stopped', code: null, signal: null, stopReason: 'session ended' },
              ownedSessionId,
            );
          } catch (error) {
            process.emitWarning(`Could not clean up runner ${record.id}: ${String(error)}`);
          }
        }),
      );
      try {
        await container.ptyHost.disposeAll();
      } finally {
        container.lifeline.dispose();
        container.runnerRegistry.close();
      }
    })();
    return runtimeDisposal;
  };

  const publishRuns = async (ownedSessionId: string): Promise<void> => {
    try {
      const records = await container.runnerRegistry.listAll(ownedSessionId);
      const nextBackgroundWork = records
        .filter((record) => record.state === 'running')
        .map((record) => ({
          id: record.id,
          sessionId: record.sessionId,
          label: record.name,
          status: record.state,
        }));
      if (JSON.stringify(nextBackgroundWork) !== JSON.stringify(backgroundWorkItems)) {
        backgroundWorkItems = nextBackgroundWork;
        backgroundWorkProvider?.update();
      }
      directEvents.publish(RUNNER_RUNS_TYPE, ownedSessionId, {
        runs: presentRunnerRuns(records, Date.now()),
      });
    } catch (error) {
      process.emitWarning(`Could not publish runner state: ${String(error)}`);
    }
  };
  let publishInFlight: Promise<void> | undefined;
  let publishAgain = false;
  let unsubscribeRunnerUpdates: (() => void) | undefined;
  const requestPublish = (ownedSessionId: string): void => {
    publishAgain = true;
    if (publishInFlight !== undefined) return;
    publishInFlight = (async () => {
      do {
        publishAgain = false;
        await publishRuns(ownedSessionId);
      } while (publishAgain);
    })()
      .catch((error: unknown) => {
        process.emitWarning(`Could not schedule runner state publication: ${String(error)}`);
      })
      .finally(() => {
        publishInFlight = undefined;
      });
  };

  // Sequenced so two runners exiting in the same tick each wake the agent once.
  const wakeForFinished = (ownedSessionId: string): void => {
    if (closing) return;
    wakes = wakes
      .then(async () => {
        if (closing) return;
        let retry = false;
        // Deleting the entry being visited is safe for a Set iterator.
        for (const id of watched) {
          if (closing) return;
          try {
            const record = await container.runnerRegistry.get(id, ownedSessionId);
            if (closing) return;
            if (record?.state === 'running') continue;
            // A record swept before it was seen leaves nothing to report.
            if (record)
              await wakeAgent?.(
                formatRunnerFinished(record),
                `runner-finished:${JSON.stringify([ownedSessionId, id])}`,
              );
            watched.delete(id);
          } catch (error) {
            retry = true;
            process.emitWarning(`Could not report finished runner ${id}: ${String(error)}`);
          }
        }
        if (retry && !closing && retryTimer === undefined) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            wakeForFinished(ownedSessionId);
          }, COMPLETION_RETRY_MS);
          retryTimer.unref?.();
        }
        if (watched.size === 0) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
          unsubscribeWatched?.();
          unsubscribeWatched = undefined;
        }
      })
      .catch((error: unknown) => {
        process.emitWarning(`Could not report a finished runner: ${String(error)}`);
      });
  };

  const watchRunner = (id: string): void => {
    const ownedSessionId = sessionId;
    if (!wakeAgent || closing || ownedSessionId === undefined) return;
    watched.add(id);
    // Independent of the optional activity: the wake-up must not depend on a
    // browser watching the runner list.
    unsubscribeWatched ??= container.runnerRegistry.subscribe(() => wakeForFinished(ownedSessionId), ownedSessionId);
    // It may already have exited between promotion and subscription.
    wakeForFinished(ownedSessionId);
  };

  const activity: DoomHeadlessActivity = {
    name: 'runner',
    start: async (executionContext: DoomHeadlessExecutionContext) => {
      await ensureSession(executionContext.sessionId);
      const unsubscribe = container.runnerRegistry.subscribe(
        () => requestPublish(executionContext.sessionId),
        executionContext.sessionId,
      );
      unsubscribeRunnerUpdates = unsubscribe;
      requestPublish(executionContext.sessionId);
      return () => {
        unsubscribe();
        if (unsubscribeRunnerUpdates === unsubscribe) unsubscribeRunnerUpdates = undefined;
        // Let the next optional activation reconcile again, while keeping
        // the retained runtime and all child job supervisors alive.
        supervision = undefined;
      };
    },
  };
  return {
    container,
    activity,
    ensureSession,
    watchRunner,
    backgroundWorkPlugin: (context) => {
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
    },
    async dispose() {
      // Session cleanup completes every runner it stops, and none of those may
      // start a turn in a session that is going away.
      closing = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      watched.clear();
      unsubscribeWatched?.();
      unsubscribeWatched = undefined;
      unsubscribeRunnerUpdates?.();
      unsubscribeRunnerUpdates = undefined;
      await wakes;
      await disposeRuntime();
    },
  };
}
