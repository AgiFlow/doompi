import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

export default {
  // The package index is Help-catalog material, not standing instruction, so it
  // only enters the prompt while Help mode is active.
  when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor' as const, mode: 'help' } },
  name: 'doompi-model-guidance',
  kind: 'context' as const,
  read: () => readPackageResource(import.meta.url, 'llms.txt'),
};
