import { defineResource, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

export default defineResource(
  (context: WithRoot<PiPluginContext<undefined>, PiPluginContributions<undefined>>) => context.root.resources![0]!,
);
