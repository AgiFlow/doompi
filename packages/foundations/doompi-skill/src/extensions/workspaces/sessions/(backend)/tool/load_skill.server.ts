import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

/** The session agent's skill loader; the Pi CLI keeps Pi's own skill handling. */
export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, DoomServerSessionPlugin>) => context.root.tools?.[0],
  { cardinality: 'optional' },
);
