import { defineResource } from '@agimon-ai/doompi-core/extensionFile';
import { packageResourcePath, readPackageResource } from '@agimon-ai/doompi-core/serverFacet';

export default defineResource({
  name: 'doompi-author-major-mode',
  description:
    "Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.",
  when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor' as const, mode: 'help' } },
  kind: 'skill' as const,
  path: packageResourcePath(import.meta.url, 'src/prompts/doompi-author-major-mode/SKILL.md'),
  read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-author-major-mode/SKILL.md'),
});
