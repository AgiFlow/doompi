import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-skill',
  description:
    "Use DoomPi's skill catalog and deferred discovery. Use when browsing available skills, invoking /skill:name, understanding Help and extension-owned skill groups, or diagnosing why a skill is absent or shadowed.",
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-skill/SKILL.md'),
});
