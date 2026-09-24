import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { packageResourcePath, readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

import { CONFIG_HELP_SKILL } from '../../../../../constants/config';

export default defineResource({
  ...CONFIG_HELP_SKILL,
  when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor' as const, mode: 'help' } },
  kind: 'skill' as const,
  path: packageResourcePath(import.meta.url, 'src/prompts/doompi-author-config/SKILL.md'),
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-config/SKILL.md'),
});
