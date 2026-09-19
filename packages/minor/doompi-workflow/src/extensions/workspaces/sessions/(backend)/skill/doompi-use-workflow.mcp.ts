import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-workflow',
  description:
    'Use DoomPi workflows. Use when discovering or launching workflows, monitoring or controlling asynchronous runs, interpreting terminal notifications, or recovering a failed run safely.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-workflow/SKILL.md'),
});
