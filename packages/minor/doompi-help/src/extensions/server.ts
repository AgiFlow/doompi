import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createHelpServerSession } from '../controllers/helpServerSession';

export const helpServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-help',
  session: ({ agent }) => (agent ? createHelpServerSession(agent) : {}),
});
export default helpServerFacet;
