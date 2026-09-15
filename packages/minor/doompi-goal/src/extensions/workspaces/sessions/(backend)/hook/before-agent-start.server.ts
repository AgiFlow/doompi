import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, Partial<DoomServerSessionPlugin>>) =>
    context.root.hooks?.find((hook) => hook.event === 'before_agent_start'),
  { cardinality: 'optional' },
);
