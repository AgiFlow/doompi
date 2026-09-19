import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-runner',
  description:
    'Use Doom Pi Runner to supervise shell commands, inspect durable logs, provide interactive input, and stop background runs.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-runner/SKILL.md'),
});
