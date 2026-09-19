import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-author',
  description:
    'Use @agimon-ai/doompi-author: Visual steering workspace for focused document review and bounded authoring',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-author/SKILL.md'),
});
