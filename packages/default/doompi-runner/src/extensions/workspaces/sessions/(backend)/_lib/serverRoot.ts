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
    (async (content: string, requestId: string): Promise<void> => {
      try {
        // 'steer' joins a running turn and starts one on an idle session.
        // Reuse completion identity across retries and acknowledge admission, not settlement.
        if (!execution.session.admitPrompt) throw new Error('The session cannot admit a runner notification.');
        await execution.session.admitPrompt(content, 'steer', undefined, requestId);
      } catch (error) {
        // Keep completion ownership with the watcher until admission succeeds.
        await Promise.resolve()
          .then(() => execution.client.notify({ body: String(error), level: 'warning' }))
          .catch(() => undefined);
        throw error;
      }
    });
  const runtime = createRunnerServerRuntime(dependencies, host.context.directEvents, wakeAgent);
  const bash = (wakeOnExit: boolean) =>
    createHeadlessBashTool(
      {
        run: async (request) => {
          await runtime.ensureSession(request.sessionId);
          const result = await dependencies.bashRunService.run({
            ...request,
            ...(signal ? { signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal } : {}),
          });
          // Without this, nothing tells the agent the runner ended.
          if (wakeOnExit && result.kind === 'promoted') runtime.watchRunner(result.id);
          return result;
        },
      },
      summarizeLog,
    );
  const value = {
    tool: bash(true),
    // Remote MCP runners must not wake the local agent; the remote caller polls instead.
    remoteTool: bash(false),
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
