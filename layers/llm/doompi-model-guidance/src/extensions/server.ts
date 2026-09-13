import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { modelGuidanceHook } from '../controllers/modelGuidanceHook';
import { readPackageResource } from '../services/packageResources';

export const modelGuidanceServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-model-guidance',
  session: {
    hooks: [modelGuidanceHook],
    resources: [
      { name: 'doompi-model-guidance', kind: 'context', read: () => readPackageResource('llms.txt') },
      {
        name: 'doompi-use-model-guidance',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-use-model-guidance/SKILL.md'),
      },
      { name: 'doompi-model-guidance-readme', kind: 'context', read: () => readPackageResource('README.md') },
    ],
  },
});
export default modelGuidanceServerFacet;
