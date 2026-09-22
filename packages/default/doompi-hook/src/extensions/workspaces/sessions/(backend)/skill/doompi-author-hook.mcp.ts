import { defineMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineMcpSkill({
  name: 'doompi-author-hook',
  description:
    'Author DoomPi repository or plugin hooks. Use when creating or changing .doom/hooks.yaml, selecting hook groups from modes.yaml, writing hook commands, or adapting Claude Code hook payloads and decisions to DoomPi.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-hook/SKILL.md'),
});
