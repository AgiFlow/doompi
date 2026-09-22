import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createDomainServerCommand } from '../_lib/domainServerCommand';
export default defineRoutedContribution(
  ({ agent }: DoomServerPluginContext) => (agent ? createDomainServerCommand(agent) : undefined),
  { cardinality: 'optional' },
);
