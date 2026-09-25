import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import type { Context } from '@deepseek-ai/cordis';

import { createHeadlessBashTool, createHeadlessRunnersCommand } from '../../../../../services/headless';
import { summarizeLog } from '../../../../../services/logReader';
import { createRunnerDependencies } from '../../../../../services/runnerDependencies';
import { createRunnerServerRuntime } from '../../../../../services/runnerServerRuntime';

export const RUNNER_SERVER_SCOPE_SERVICE = 'doom/runner-server-scope';

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/runner-server-scope': RunnerServerScope;
  }
}

export const createRunnerServerRoot = ({ host }: DoomServerPluginContext) => {
  if (!host.context.directEvents) throw new Error('Runner headless facet requires the session direct event bus.');
  if (!host.context.cwd || !host.context.environment) {
    throw new Error('Runner headless facet requires session cwd and environment.');
  }
  const dependencies = createRunnerDependencies({ cwd: host.context.cwd, environment: host.context.environment });
  const runtime = createRunnerServerRuntime(dependencies, host.context.directEvents);
  const value = {
    tool: createHeadlessBashTool(
      {
        run: async (request) => {
          await runtime.ensureSession(request.sessionId);
          return dependencies.bashRunService.run(request);
        },
      },
      summarizeLog,
    ),
    command: createHeadlessRunnersCommand(dependencies),
  };
  return {
    value,
    services: [
      runtime.backgroundWorkPlugin,
      (context: Context) => {
        context.plugin((providerContext) => providerContext.provide(RUNNER_SERVER_SCOPE_SERVICE, value));
      },
    ],
    activities: [runtime.activity],
    onStop: runtime.dispose,
  };
};

export type RunnerServerScope = Awaited<ReturnType<typeof createRunnerServerRoot>>['value'];
