import {
  DOOM_BACKGROUND_WORK_SERVICE,
  readDoomBackgroundWorkService,
  type BackgroundProviderWorkItem,
  type BackgroundWorkProviderHandle,
} from '@agimon-ai/doompi-core/background-work';
import type { DoomHeadlessActivity, DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';

import { BACKGROUND_WORK_PROVIDER } from '../../constants/runnerRuntime';
import { RUNNER_RUNS_TYPE } from '../../constants/webRunners';
import { reconcileActiveRunners, stopRunnerProcess } from '../reconcile';
import type { RunnerDependencies } from '../runnerDependencies/type';
import { presentRunnerRuns } from '../webRunnerRuns';

export interface RunnerServerRuntime {
  readonly container: RunnerDependencies;
  readonly activity: DoomHeadlessActivity;
  readonly backgroundWorkPlugin: (context: Context) => void;
  dispose(this: void): Promise<void>;
}
export function createRunnerServerRuntime(
  container: RunnerDependencies,
  directEvents: NonNullable<DoomServerHostService['context']['directEvents']>,
): RunnerServerRuntime {
  let sessionId: string | undefined;
  let supervision: Promise<void> | undefined;
  let runtimeDisposal: Promise<void> | undefined;
  let backgroundWorkItems: BackgroundProviderWorkItem[] = [];
  let backgroundWorkProvider: BackgroundWorkProviderHandle | undefined;

  // The activity is optional and source-gated. The retained facet owns the
  // session runtime, so disabling the activity must not tear down its jobs.
  const startSupervision = (executionContext: DoomHeadlessExecutionContext): Promise<void> => {
    sessionId ??= executionContext.sessionId;
    supervision ??= (async () => {
      try {
        container.paths.setSessionId(executionContext.sessionId);
        await container.lifeline.arm(executionContext.sessionId);
        const reconciled = await reconcileActiveRunners({
          registry: container.runnerRegistry,
          launcher: container.launcher,
          rmuxBackend: container.rmuxBackend,
          processControl: container.processControl,
          currentHostPid: process.pid,
          startup: true,
        });
        for (const error of reconciled.errors) process.emitWarning(error);
      } catch (error) {
        process.emitWarning(`Could not initialize headless runner supervision: ${String(error)}`);
      }
    })();
    return supervision;
  };

  const disposeRuntime = (): Promise<void> => {
    runtimeDisposal ??= (async () => {
      await supervision;
      const ownedSessionId = sessionId;
      if (ownedSessionId === undefined) return;
      const records = await container.runnerRegistry.listBySession(ownedSessionId).catch(() => []);
      await Promise.all(
        records.map(async (record) => {
          try {
            await stopRunnerProcess(record, container.launcher, container.rmuxBackend);
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

  const activity: DoomHeadlessActivity = {
    name: 'runner',
    start: async (executionContext: DoomHeadlessExecutionContext) => {
      await startSupervision(executionContext);
      requestPublish(executionContext.sessionId);
      const unsubscribe = container.runnerRegistry.subscribe(() => requestPublish(executionContext.sessionId));
      unsubscribeRunnerUpdates = unsubscribe;
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
      unsubscribeRunnerUpdates?.();
      unsubscribeRunnerUpdates = undefined;
      await disposeRuntime();
    },
  };
}
