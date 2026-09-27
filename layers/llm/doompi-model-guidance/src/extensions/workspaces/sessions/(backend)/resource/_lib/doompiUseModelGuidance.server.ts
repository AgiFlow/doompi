import { DOOM_HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default {
  name: 'doompi-use-model-guidance',
  when: DOOM_HELP_WHEN,
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-model-guidance/SKILL.md'),
};
