import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { voiceClientSettingsApi } from '../../../../services/voiceClientSettingsApi';

export default defineRoutedContribution(
  ({ host }: DoomServerPluginContext) => (host.scope === 'global' ? voiceClientSettingsApi : undefined),
  { cardinality: 'optional' },
);
