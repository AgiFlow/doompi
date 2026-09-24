import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { packageResourcePath, readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineResource({
  name: 'doompi-author-domain',
  description:
    'Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.',
  when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor' as const, mode: 'help' } },
  kind: 'skill' as const,
  path: packageResourcePath(import.meta.url, 'src/prompts/doompi-author-domain/SKILL.md'),
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-domain/SKILL.md'),
});
