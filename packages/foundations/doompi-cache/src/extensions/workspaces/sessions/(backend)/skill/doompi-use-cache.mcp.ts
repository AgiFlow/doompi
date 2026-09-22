import { defineMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineMcpSkill({
  name: 'doompi-use-cache',
  description: 'Inspect DoomPi provider prompt cache policy, routing identity, and provider-observed usage.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-cache/SKILL.md'),
});
