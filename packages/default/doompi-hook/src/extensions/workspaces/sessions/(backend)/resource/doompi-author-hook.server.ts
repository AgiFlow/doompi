import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { DOOM_HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineResource({
  name: 'doompi-author-hook',
  when: DOOM_HELP_WHEN,
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-hook/SKILL.md'),
});
