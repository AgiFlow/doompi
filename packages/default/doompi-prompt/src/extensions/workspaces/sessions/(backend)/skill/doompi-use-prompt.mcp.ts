import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-prompt',
  description: 'Use @agimon-ai/doompi-prompt: Staged recent prompts and saved prompt templates for DoomPi',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-prompt/SKILL.md'),
});
