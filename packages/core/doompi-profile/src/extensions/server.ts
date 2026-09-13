import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createProfileServerCommand, profileIdentityHook, readSelectedPersona } from '../controllers/profileServer';
import { readPackageResource } from '../services/packageResources';
export const profileServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-profile',
  session: ({ agent }) => ({
    commands: agent ? [createProfileServerCommand(agent)] : [],
    resources: [
      { name: 'doompi/profile-config', kind: 'context', read: readSelectedPersona },
      {
        name: 'doompi-author-profile',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-author-profile/SKILL.md'),
      },
    ],
    hooks: [profileIdentityHook],
  }),
});

export default profileServerFacet;
