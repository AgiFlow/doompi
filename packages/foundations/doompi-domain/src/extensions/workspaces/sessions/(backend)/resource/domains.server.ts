import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { DomainServerScope } from '../_lib/serverScope';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, DomainServerScope>) => context.root.resources,
  { cardinality: 'many' },
);
