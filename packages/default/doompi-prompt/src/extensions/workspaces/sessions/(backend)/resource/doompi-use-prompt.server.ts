import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineResource({
  name: 'doompi-use-prompt',
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-prompt/SKILL.md'),
});
