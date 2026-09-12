import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { createSandboxServerRuntime } from '../controllers/serverRuntime';
export const sandboxServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-sandbox',
  session: ({ agent }) => (agent ? createSandboxServerRuntime(agent.context.environment) : {}),
});
export default sandboxServerFacet;
