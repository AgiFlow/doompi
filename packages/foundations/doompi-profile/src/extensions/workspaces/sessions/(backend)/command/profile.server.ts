import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createProfileServerCommand } from '../_lib/profileServer';
export default defineRoutedContribution(
  ({ agent }: DoomServerPluginContext) => (agent ? createProfileServerCommand(agent) : undefined),
  { cardinality: 'optional' },
);
