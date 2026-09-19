import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-author-workflow',
  description:
    'Author DoomPi workflow definitions. Use when creating or changing a *.workflow.yml graph, arranging job dependencies and host-executed steps, or deciding how a command requiring a TTY should run.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-workflow/SKILL.md'),
});
