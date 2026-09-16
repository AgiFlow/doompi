import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { voiceReadinessApi } from '../../../../services/voiceReadinessApi';

export default defineRoutedContribution(
  ({ host }: DoomServerPluginContext) => (host.scope === 'global' ? voiceReadinessApi : undefined),
  { cardinality: 'optional' },
);
