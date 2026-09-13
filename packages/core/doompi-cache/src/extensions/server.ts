import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { cacheHooks, cacheResource } from '../controllers/cacheHooks';
export const cacheServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-cache',
  session: { resources: [cacheResource], hooks: cacheHooks },
});
export default cacheServerFacet;
