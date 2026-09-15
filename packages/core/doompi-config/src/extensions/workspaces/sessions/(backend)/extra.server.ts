import { readPackageResource, selectionMetadata } from '../../../../services/configResources';

export default {
  resources: [
    { name: 'doompi/config', kind: 'context' as const, read: selectionMetadata },
    {
      name: 'doompi-author-config',
      kind: 'skill' as const,
      read: () => readPackageResource('src/prompts/doompi-author-config/SKILL.md'),
    },
  ],
};
