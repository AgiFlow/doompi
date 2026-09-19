import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-use-user-feedback',
  description: 'Use structured user questions with interactive and autonomous Voice handoff for Pi agents.',
  read: () => readPackageResource(import.meta.url, 'README.md'),
});
