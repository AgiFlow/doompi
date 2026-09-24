import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { packageResourcePath, readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineResource({
  name: 'doompi-author-profile',
  description:
    'Configure DoomPi profile discovery, personas, environment defaults, and precedence in profiles.yaml. Use when creating or changing personal or repository profiles. Do not use for config.yaml runtime settings, modes.yaml, or domains.yaml.',
  when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor' as const, mode: 'help' } },
  kind: 'skill' as const,
  path: packageResourcePath(import.meta.url, 'src/prompts/doompi-author-profile/SKILL.md'),
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-profile/SKILL.md'),
});
