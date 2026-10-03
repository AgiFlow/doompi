import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { DOOM_HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { packageResourcePath, readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

import { HOOK_HELP_SKILL } from '../../../../../constants/hook';

export default defineResource({
  ...HOOK_HELP_SKILL,
  when: DOOM_HELP_WHEN,
  kind: 'skill' as const,
  path: packageResourcePath(import.meta.url, 'src/prompts/doompi-author-hook/SKILL.md'),
  read: async () => {
    const text = await readPackageResource(import.meta.url, 'src/prompts/doompi-author-hook/SKILL.md');
    if (!text.trim()) throw new Error('The installed hook-authoring skill is missing or unreadable.');
    return text;
  },
});
