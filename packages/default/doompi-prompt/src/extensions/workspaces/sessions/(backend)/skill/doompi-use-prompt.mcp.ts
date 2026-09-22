import { defineMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineMcpSkill({
  name: 'doompi-use-prompt',
  description: 'Use @agimon-ai/doompi-prompt: Staged recent prompts and saved prompt templates for DoomPi',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-prompt/SKILL.md'),
});
