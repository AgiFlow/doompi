import { defineResource } from '@agimon-ai/doompi-core/extension-file';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineResource({
  name: 'doompi-author-profile',
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-profile/SKILL.md'),
});
