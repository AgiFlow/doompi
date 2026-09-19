import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-git',
  description:
    'Use @agimon-ai/doompi-git: Git worktree sessions for DoomPi: spawn an isolated worktree with its own session and manage it from the parent',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-git/SKILL.md'),
});
