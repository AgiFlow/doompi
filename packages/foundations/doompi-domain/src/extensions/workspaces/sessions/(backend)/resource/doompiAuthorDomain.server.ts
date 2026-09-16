import { defineResource } from '@agimon-ai/doompi-core/extension-file';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineResource({
  name: 'doompi-author-domain',
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-domain/SKILL.md'),
});
