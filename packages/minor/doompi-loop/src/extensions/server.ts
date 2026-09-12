import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { createSessionState } from '../controllers/serverRuntime';
export const loopServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-loop',
  session: ({ agent }) => (agent ? createSessionState(agent) : {}),
});
export default loopServerFacet;
