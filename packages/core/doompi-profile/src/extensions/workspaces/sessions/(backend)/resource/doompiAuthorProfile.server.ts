import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { readPackageResource } from '../../../../../services/packageResources';
export default defineRoutedContribution(
  {
    name: 'doompi-author-profile',
    kind: 'skill' as const,
    read: () => readPackageResource('src/prompts/doompi-author-profile/SKILL.md'),
  },
  {},
);
