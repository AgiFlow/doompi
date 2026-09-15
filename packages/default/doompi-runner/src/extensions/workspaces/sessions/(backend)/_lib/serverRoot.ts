import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createHeadlessBashTool, createHeadlessRunnersCommand } from '../../../../../services/headless';
import { summarizeLog } from '../../../../../services/logReader';
import { createRunnerDependencies } from '../../../../../services/runnerDependencies';
import { createRunnerServerRuntime } from '../../../../../services/runnerServerRuntime';
export const createRunnerServerRoot = ({ host }: DoomServerPluginContext) => {
  if (!host.context.directEvents) throw new Error('Runner headless facet requires the session direct event bus.');
  const dependencies = createRunnerDependencies({ environment: Object.freeze({ ...process.env }) });
  const runtime = createRunnerServerRuntime(dependencies, host.context.directEvents);
  return {
    value: {
      tool: createHeadlessBashTool({ run: (request) => dependencies.bashRunService.run(request) }, summarizeLog),
      command: createHeadlessRunnersCommand(dependencies),
    },
    services: [runtime.backgroundWorkPlugin],
    activities: [runtime.activity],
    onStop: runtime.dispose,
  };
};
export type RunnerServerScope = Awaited<ReturnType<typeof createRunnerServerRoot>>['value'];
