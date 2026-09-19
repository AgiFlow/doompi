import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-plan',
  description:
    'Use Doom Pi Plan to draft reviewable normal, debug, or Fable-assisted plans, persist them, and exit safely.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-plan/SKILL.md'),
});
