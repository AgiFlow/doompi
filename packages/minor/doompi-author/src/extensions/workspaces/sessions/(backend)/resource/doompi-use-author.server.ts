import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineResource({
  when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor' as const, mode: 'author' } },
  name: 'doompi-use-author',
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-author/SKILL.md'),
});
