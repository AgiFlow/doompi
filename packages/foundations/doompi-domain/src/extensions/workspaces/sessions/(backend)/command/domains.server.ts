import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createDomainServerCommand } from '../_lib/domainServerCommand';
export default defineRoutedContribution(
  ({ agent }: DoomServerPluginContext) => (agent ? createDomainServerCommand(agent) : undefined),
  { cardinality: 'optional' },
);
