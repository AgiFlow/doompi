import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { createHelpServerSession } from '../controllers/helpServerSession';

export const helpServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-help',
  session: ({ agent }) => (agent ? createHelpServerSession(agent) : {}),
});
export default helpServerFacet;
