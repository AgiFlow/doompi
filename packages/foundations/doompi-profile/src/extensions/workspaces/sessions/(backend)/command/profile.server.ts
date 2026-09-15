import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createProfileServerCommand } from '../_lib/profileServer';
export default defineRoutedContribution(
  ({ agent }: DoomServerPluginContext) => (agent ? createProfileServerCommand(agent) : undefined),
  { cardinality: 'optional' },
);
