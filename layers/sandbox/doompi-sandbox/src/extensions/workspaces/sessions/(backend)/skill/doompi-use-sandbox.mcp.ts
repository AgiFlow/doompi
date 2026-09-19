import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-sandbox',
  description:
    'Use @agimon-ai/doompi-sandbox: Container sandbox for DoomPi launches: the agent, extensions, and tools run inside Docker or Podman while the terminal stays on the host',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-sandbox/SKILL.md'),
});
