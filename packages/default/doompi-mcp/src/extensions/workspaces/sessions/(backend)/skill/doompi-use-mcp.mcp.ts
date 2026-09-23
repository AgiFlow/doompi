import { defineMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineMcpSkill({
  name: 'doompi-use-mcp',
  description:
    'Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, and troubleshoot tool availability.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-mcp/SKILL.md'),
});
