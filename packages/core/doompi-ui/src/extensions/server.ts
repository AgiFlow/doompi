import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { PACKAGE_SOURCE } from '../constants/ui';
import { createUiServerContributions } from '../controllers/sessionInventory';

export const uiServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  session: () => createUiServerContributions(),
});
export default uiServerFacet;
