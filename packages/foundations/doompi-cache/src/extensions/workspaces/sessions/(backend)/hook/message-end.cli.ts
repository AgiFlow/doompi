import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

type CachePiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, CachePiScope>) => context.root.events.message_end,
);
