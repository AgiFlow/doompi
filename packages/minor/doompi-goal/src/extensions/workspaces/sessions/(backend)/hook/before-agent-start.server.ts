import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, Partial<DoomServerSessionPlugin>>) =>
    context.root.hooks?.find((hook) => hook.event === 'before_agent_start'),
  { cardinality: 'optional' },
);
