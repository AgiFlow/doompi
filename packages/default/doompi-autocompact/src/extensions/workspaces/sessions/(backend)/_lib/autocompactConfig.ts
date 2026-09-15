import { loadDoomConfig } from '@agimon-ai/doompi-config';
import type { DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';

export const autocompactConfigResource: DoomHeadlessResource = {
  name: 'doompi/autocompact-config',
  kind: 'context',
  read: (execution) => JSON.stringify(loadDoomConfig(execution.repoRoot).modes?.autocompact ?? {}),
};
