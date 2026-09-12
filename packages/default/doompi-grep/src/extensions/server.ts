import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { PACKAGE_SOURCE } from '../constants/package';
import { createHeadlessGrepTool } from '../services/headlessGrep';

export const grepServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  session: () => ({ tools: [createHeadlessGrepTool()] }),
});
export default grepServerFacet;
