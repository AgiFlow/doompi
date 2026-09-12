import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { PACKAGE_SOURCE } from '../constants/hook';
import { hookResource, serverHooks } from '../controllers/serverHooks';
export const hookServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  session: { resources: [hookResource], hooks: serverHooks },
});
export default hookServerFacet;
