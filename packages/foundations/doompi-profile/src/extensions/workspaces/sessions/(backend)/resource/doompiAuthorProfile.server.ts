import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { readPackageResource } from '../../../../../services/packageResources';
export default defineResource({
  name: 'doompi-author-profile',
  kind: 'skill' as const,
  read: () => readPackageResource('src/prompts/doompi-author-profile/SKILL.md'),
});
