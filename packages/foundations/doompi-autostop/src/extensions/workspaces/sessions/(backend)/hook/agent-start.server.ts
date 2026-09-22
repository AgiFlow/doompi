import { defineHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

type AutoStopServerScope = Awaited<ReturnType<typeof import('../root.server').default>>['value'];
export default defineHook((context: WithRoot<DoomServerPluginContext, AutoStopServerScope>) =>
  context.root.hooks.find((hook) => hook.event === 'agent_start')!,
);
