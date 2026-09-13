import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createHeadlessBashTool, createHeadlessRunnersCommand } from '../controllers/headless';
import { api } from '../controllers/runnerLogApi';
import { summarizeLog } from '../services/logReader';
import { createRunnerDependencies } from '../services/runnerDependencies';
import { createRunnersChannel } from '../services/runnersChannel';
import { createRunnerServerRuntime } from '../services/runnerServerRuntime';
export const runnerServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-runner',
  global: { channels: [createRunnersChannel] },
  workspace: { channels: [createRunnersChannel] },
  session: ({ host, agent }) => {
    if (!agent) return { api: [api] };
    if (!host.context.directEvents) throw new Error('Runner headless facet requires the session direct event bus.');
    const dependencies = createRunnerDependencies({ environment: Object.freeze({ ...process.env }) });
    const runtime = createRunnerServerRuntime(dependencies, host.context.directEvents);
    return {
      services: [runtime.backgroundWorkPlugin],
      api: [api],
      tools: [createHeadlessBashTool({ run: (request) => dependencies.bashRunService.run(request) }, summarizeLog)],
      commands: [createHeadlessRunnersCommand(dependencies)],
      activities: [runtime.activity],
      onStop: runtime.dispose,
    };
  },
});
export default runnerServerFacet;
