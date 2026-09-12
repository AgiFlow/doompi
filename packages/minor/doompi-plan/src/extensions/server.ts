import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { api } from '../controllers/planApi';
import { createPlanServerSession } from '../controllers/planServerSession';

export const planServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-plan',
  session: ({ agent }) => ({
    api: [api],
    ...(agent ? createPlanServerSession(agent) : {}),
  }),
});
export default planServerFacet;
