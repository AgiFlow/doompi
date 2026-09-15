import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, DoomServerSessionPlugin>) => context.root.resources!,
  { cardinality: 'many' },
);
