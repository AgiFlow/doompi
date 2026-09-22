import { defineMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineMcpSkill({
  name: 'doompi-author-domain',
  description:
    'Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.',
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-domain/SKILL.md'),
});
