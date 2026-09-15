import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createMajorModeServerCommand } from '../_lib/majorModeServerCommand';
export default defineRoutedContribution(
  ({ agent }: DoomServerPluginContext) => (agent ? createMajorModeServerCommand(agent) : undefined),
  { cardinality: 'optional' },
);
