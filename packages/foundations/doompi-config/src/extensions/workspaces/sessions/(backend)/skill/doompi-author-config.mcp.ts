import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineMcpSkill({
  name: 'doompi-author-config',
  description:
    'Configure DoomPi runtime settings, source precedence, and typed session configuration. Use for config.yaml, the doom/config Cordis service, immutable context snapshots, or shared selection transition state. Do not use for defining modes.yaml, domains.yaml, or profiles.yaml.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-config/SKILL.md'),
});
