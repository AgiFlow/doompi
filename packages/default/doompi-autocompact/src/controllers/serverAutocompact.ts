import { loadDoomConfig } from '@agimon-ai/doompi-config';
import { type DoomHeadlessActivity, type DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';

export const autocompactResource: DoomHeadlessResource = {
  name: 'doompi/autocompact-config',
  kind: 'context',
  read: (execution) => JSON.stringify(loadDoomConfig(execution.repoRoot).modes?.autocompact ?? {}),
};

export const autocompactActivity: DoomHeadlessActivity = {
  name: 'doompi-autocompact',
  start(execution) {
    const enabled = loadDoomConfig(execution.repoRoot).modes?.autocompact?.enabled === true;
    execution.client.setStatus('doom-autocompact', enabled ? 'native fallback' : undefined);
    return () => execution.client.setStatus('doom-autocompact', undefined);
  },
};
