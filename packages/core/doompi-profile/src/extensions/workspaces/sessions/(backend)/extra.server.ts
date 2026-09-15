import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import {
  createProfileServerCommand,
  profileIdentityHook,
  readSelectedPersona,
} from '../../../../controllers/profileServer';
import { readPackageResource } from '../../../../services/packageResources';

export default ({ agent }: DoomServerPluginContext) => ({
  commands: agent ? [createProfileServerCommand(agent)] : [],
  resources: [
    { name: 'doompi/profile-config', kind: 'context' as const, read: readSelectedPersona },
    {
      name: 'doompi-author-profile',
      kind: 'skill' as const,
      read: () => readPackageResource('src/prompts/doompi-author-profile/SKILL.md'),
    },
  ],
  hooks: [profileIdentityHook],
});
