import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-loop',
  description: 'Use Doom Pi Loop to start, inspect, and stop session-scoped recurring prompts safely.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-loop/SKILL.md'),
});
