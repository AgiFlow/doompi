import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { readPackageResource, selectionMetadata } from '../services/configResources';

import { settingsApi } from '../controllers/settingsApi';

export const configServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-config',
  global: { api: [settingsApi] },
  workspace: { api: [settingsApi] },
  session: {
    resources: [
      { name: 'doompi/config', kind: 'context', read: selectionMetadata },
      {
        name: 'doompi-author-config',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-author-config/SKILL.md'),
      },
    ],
  },
});

export default configServerFacet;
