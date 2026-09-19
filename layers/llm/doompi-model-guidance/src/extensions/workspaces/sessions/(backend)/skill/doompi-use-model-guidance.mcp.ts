import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-model-guidance',
  description:
    'Use @agimon-ai/doompi-model-guidance: per-model system prompt guidance, layered across global and repository scope',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-model-guidance/SKILL.md'),
});
