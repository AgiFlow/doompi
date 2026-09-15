import { loadDoomConfig } from '@agimon-ai/doompi-config';
import { defineActivity } from '@agimon-ai/doompi-core/extension-file';

export default {
  name: 'doompi/autocompact-config',
  kind: 'context' as const,
  read: (execution) => JSON.stringify(loadDoomConfig(execution.repoRoot).modes?.autocompact ?? {}),
};
