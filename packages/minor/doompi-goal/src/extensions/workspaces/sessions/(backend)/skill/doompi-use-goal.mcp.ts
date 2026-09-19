import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-goal',
  description:
    'Use Doom Pi Goal to start, budget, pause, resume, complete, block, and inspect persistent repository goals.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-goal/SKILL.md'),
});
