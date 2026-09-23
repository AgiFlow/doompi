import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

type ConfigPiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];
export default defineCliHook((context: WithRoot<PiPluginContext, ConfigPiScope>) => context.root.onSessionStart);
