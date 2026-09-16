import { defineResource } from '@agimon-ai/doompi-core/extension-file';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default defineResource({
  when: { state: { 'minor-mode': 'author' }, attribution: { kind: 'minor' as const, mode: 'author' } },
  name: 'doompi-use-author',
  kind: 'skill' as const,
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-author/SKILL.md'),
});
