import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

type AutoStopPiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliHook((context: WithRoot<PiPluginContext<unknown>, AutoStopPiScope>) => context.root.cancel);
