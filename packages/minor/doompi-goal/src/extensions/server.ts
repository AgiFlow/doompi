import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { createGoalServer } from '../controllers/goalServer';
export const goalServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-goal',
  session: ({ agent }) => (agent ? createGoalServer(agent) : {}),
});
export default goalServerFacet;
