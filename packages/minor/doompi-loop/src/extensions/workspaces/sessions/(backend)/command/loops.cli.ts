import { defineCliCommand, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

export default defineCliCommand(
  (context: WithRoot<PiPluginContext<undefined>, PiPluginContributions<undefined>>) => context.root.commands![1]!,
);
