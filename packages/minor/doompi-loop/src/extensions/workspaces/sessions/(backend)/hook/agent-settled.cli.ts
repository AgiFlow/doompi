import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

export default defineCliHook(
  (context: WithRoot<PiPluginContext<undefined>, PiPluginContributions<undefined>>) =>
    context.root.events!['agent_settled']!,
);
