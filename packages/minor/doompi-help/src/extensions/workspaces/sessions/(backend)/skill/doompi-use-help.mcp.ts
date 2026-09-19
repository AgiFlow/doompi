import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-help',
  description:
    'Use Doom Pi Help to activate package guidance, load exact-version skills, and diagnose unavailable or conflicting contributions.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-help/SKILL.md'),
});
