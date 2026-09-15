import { defineCliCommand, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

export default defineCliCommand(
  (context: WithRoot<PiPluginContext<undefined>, PiPluginContributions<undefined>>) => context.root.commands![1]!,
);
