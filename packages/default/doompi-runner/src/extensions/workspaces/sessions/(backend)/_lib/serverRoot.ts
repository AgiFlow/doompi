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

export const createRunnerServerRoot = ({ host, agent, signal }: DoomServerPluginContext) => {
  if (!host.context.directEvents) throw new Error('Runner headless facet requires the session direct event bus.');
  if (!host.context.cwd || !host.context.environment) {
    throw new Error('Runner headless facet requires session cwd and environment.');
  }
  const dependencies = createRunnerDependencies({
    cwd: host.context.cwd,
    environment: host.context.environment,
    ...(host.context.executionBudget === undefined ? {} : { executionBudget: host.context.executionBudget }),
  });
  const execution = agent?.context;
  const wakeAgent =
    execution &&
    (async (content: string): Promise<void> => {
      try {
        // 'steer' joins a running turn and starts one on an idle session.
        // `session.prompt(_, 'steer')` is enqueue-only and would park the
        // message on an idle lane, which is the bug this exists to fix.
        if (!execution.session.admitPrompt) throw new Error('The session cannot admit a runner notification.');
        await execution.session.admitPrompt(content, 'steer');
      } catch (error) {
        // The runner already finished; a failed wake-up costs the model its
        // prompt, not the result, so tell the operator instead.
        await execution.client.notify({ body: String(error), level: 'warning' });
      }
    });
  const runtime = createRunnerServerRuntime(dependencies, host.context.directEvents, wakeAgent);
  const value = {
    tool: createHeadlessBashTool(
      {
        run: async (request) => {
          await runtime.ensureSession(request.sessionId);
          const result = await dependencies.bashRunService.run({
            ...request,
            ...(signal ? { signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal } : {}),
          });
          // Without this, nothing tells the agent the runner ended.
          if (result.kind === 'promoted') runtime.watchRunner(result.id);
          return result;
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
