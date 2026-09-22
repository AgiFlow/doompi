import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createMajorModeServerCommand } from '../_lib/majorModeServerCommand';
export default defineRoutedContribution(
  ({ agent }: DoomServerPluginContext) => (agent ? createMajorModeServerCommand(agent) : undefined),
  { cardinality: 'optional' },
);
