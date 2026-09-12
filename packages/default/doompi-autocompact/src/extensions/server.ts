import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { autocompactResource, autocompactActivity } from '../controllers/serverAutocompact';
export const autocompactServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-autocompact',
  session: { resources: [autocompactResource], activities: [autocompactActivity] },
});
export default autocompactServerFacet;
