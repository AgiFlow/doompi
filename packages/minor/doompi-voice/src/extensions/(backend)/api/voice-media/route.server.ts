import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import type root from '../../root.server';

type Context = WithRoot<DoomServerPluginContext, Awaited<ReturnType<typeof root>>['value']>;

export default defineRoutedContribution(
  (context: Context) => (context.host.scope === 'global' ? context.root.mediaApi : undefined),
  { cardinality: 'optional' },
);
