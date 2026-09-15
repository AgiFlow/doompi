import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { readPackageResource } from '../../../../../services/configResources';
export default defineResource({
  name: 'doompi-author-config',
  kind: 'skill' as const,
  read: () => readPackageResource('src/prompts/doompi-author-config/SKILL.md'),
});
