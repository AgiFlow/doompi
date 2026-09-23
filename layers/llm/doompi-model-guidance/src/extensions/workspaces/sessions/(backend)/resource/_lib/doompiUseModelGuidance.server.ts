import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default {
  name: 'doompi-use-model-guidance',
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-model-guidance/SKILL.md'),
};
