import { loadDoomConfig } from '@agimon-ai/doompi-config';
import { defineRoot } from '@agimon-ai/doompi-core/extension-file';

export default defineRoot(() => ({
  value: undefined,
  activities: [
    {
      name: 'doompi-autocompact',
      start(execution) {
        const enabled = loadDoomConfig(execution.repoRoot).modes?.autocompact?.enabled === true;
        execution.client.setStatus('doom-autocompact', enabled ? 'native fallback' : undefined);
        return () => execution.client.setStatus('doom-autocompact', undefined);
      },
    },
  ],
}));
