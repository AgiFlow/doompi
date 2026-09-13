import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createSandboxServerRuntime } from '../controllers/serverRuntime';
export const sandboxServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-sandbox',
  session: ({ agent }) => (agent ? createSandboxServerRuntime(agent.context.environment) : {}),
});
export default sandboxServerFacet;
