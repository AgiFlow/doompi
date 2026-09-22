import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { settingsApi } from '../../../../services/settingsApi';

export default defineRoutedContribution(
  ({ host }: DoomServerPluginContext) => (host.scope === 'session' ? undefined : settingsApi),
  { cardinality: 'optional' },
);
