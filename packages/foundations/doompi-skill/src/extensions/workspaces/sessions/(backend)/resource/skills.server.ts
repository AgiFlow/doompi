import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, DoomServerSessionPlugin>) => context.root.resources!,
  { cardinality: 'many' },
);
