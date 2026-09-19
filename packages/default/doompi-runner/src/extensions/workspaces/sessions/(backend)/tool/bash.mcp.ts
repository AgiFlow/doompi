import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createHeadlessBashTool } from '../../../../../services/headless';
import { summarizeLog } from '../../../../../services/logReader';
import { createRunnerDependencies } from '../../../../../services/runnerDependencies';

export default defineMcpTool(() => {
  const dependencies = createRunnerDependencies({ environment: Object.freeze({ ...process.env }) });
  return createHeadlessBashTool({ run: (request) => dependencies.bashRunService.run(request) }, summarizeLog);
});
