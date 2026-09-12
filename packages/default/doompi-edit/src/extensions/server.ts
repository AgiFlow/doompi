import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { PACKAGE_SOURCE } from '../constants/package';
import { createHeadlessEditTool } from '../tools/headlessEdit';

export const editServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  session: () => ({ tools: [createHeadlessEditTool()] }),
});
export default editServerFacet;
