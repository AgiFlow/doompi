import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

type AutoStopServerScope = Awaited<ReturnType<typeof import('../root.server').default>>['value'];
export default defineRoutedContribution(
  (context: WithRoot<DoomServerPluginContext, AutoStopServerScope>) =>
    context.root.hooks.find((hook) => hook.event === 'session_shutdown')!,
  {},
);
