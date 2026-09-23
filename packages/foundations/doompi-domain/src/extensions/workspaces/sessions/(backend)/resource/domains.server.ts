import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type { DomainServerScope } from '../_lib/serverScope';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, DomainServerScope>) => context.root.resources,
  { cardinality: 'many' },
);
