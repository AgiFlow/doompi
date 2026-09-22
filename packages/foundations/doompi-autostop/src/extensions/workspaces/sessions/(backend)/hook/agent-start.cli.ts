import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

type AutoStopPiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliHook((context: WithRoot<PiPluginContext<unknown>, AutoStopPiScope>) => context.root.cancel);
