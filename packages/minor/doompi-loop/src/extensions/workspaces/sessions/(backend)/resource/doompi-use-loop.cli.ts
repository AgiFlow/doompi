import { defineResource, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

export default defineResource(
  (context: WithRoot<PiPluginContext<undefined>, PiPluginContributions<undefined>>) => context.root.resources![0]!,
);
