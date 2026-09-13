import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { PACKAGE_SOURCE } from '../constants/package';
import { createHeadlessReadTool } from '../services/readTool';

export const readServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  session: () => ({ tools: [createHeadlessReadTool()] }),
});
export default readServerFacet;
