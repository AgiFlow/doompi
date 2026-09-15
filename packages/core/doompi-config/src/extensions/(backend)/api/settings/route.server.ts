import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { settingsApi } from '../../../../services/settingsApi';

export default defineRoutedContribution(
  ({ host }: DoomServerPluginContext) => (host.scope === 'session' ? undefined : settingsApi),
  { cardinality: 'optional' },
);
