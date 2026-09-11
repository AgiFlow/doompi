/**
 * doom-runner's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. `inject` is declared on the facet itself, so the host mounts
 *   one fiber and knows the API is registered the moment it settles.
 * - Thin host adapter. It registers the package's API and returns the
 *   disposer; the surface itself stays in runnerLogApi.
 * - Scope-aware. The runner's log surface belongs to the session that owns the
 *   runners, so the hub scope registers nothing rather than mounting an API
 *   with no session behind it.
 *
 * AVOID:
 * - Starting work in apply. A facet that opens files or timers at install has
 *   the same problem an eager Pi extension has, and the server has no reload
 *   to recover from it.
 */

import {
  readDoomHeadlessHost,
  type DoomHeadlessExecutionContext,
} from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import type { RunnerDependencies } from '../../container/types.ts';
import { summarizeLog } from '../../adapters/LogReader/LogReader.ts';
import { createHeadlessBashTool, createHeadlessRunnersCommand } from '../headless.ts';
import { reconcileActiveRunners, stopRunnerProcess } from '../../services/runs/reconcile.ts';
import { api } from '../runnerLogApi.ts';

export type RunnerContainerFactory = () => RunnerDependencies;

export function createRunnerServerFacet(createContainer: RunnerContainerFactory): DoomServerFacet {
  return {
    inject: [DOOM_SERVER_HOST_SERVICE],
    apply(context: Context) {
      const server = requireDoomServerHost(context);
      const registrations = [] as Array<{ dispose(): void }>;
      if (server.scope === 'session') registrations.push(server.registerApi(api));

      const headless = readDoomHeadlessHost(context);
      if (!headless) {
        return registrations.length === 0
          ? undefined
          : () => registrations.reverse().forEach((registration) => registration.dispose());
      }

      const container = createContainer();
      let sessionId: string | undefined;
      let supervision: Promise<void> | undefined;
      let runtimeDisposal: Promise<void> | undefined;

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

      registrations.push(
        headless.registerTool(
          createHeadlessBashTool({ run: (request) => container.bashRunService.run(request) }, summarizeLog),
        ),
      );
      registrations.push(headless.registerCommand(createHeadlessRunnersCommand(container)));
      registrations.push(
        headless.registerActivity({
          name: 'runner',
          start: async (executionContext: DoomHeadlessExecutionContext) => {
            await startSupervision(executionContext);
            return () => {
              // Let the next optional activation reconcile again, while keeping
              // the retained runtime and all child job supervisors alive.
              supervision = undefined;
            };
          },
        }),
      );

      return async () => {
        await disposeRuntime();
        for (const registration of registrations.reverse()) registration.dispose();
      };
    },
  };
}
