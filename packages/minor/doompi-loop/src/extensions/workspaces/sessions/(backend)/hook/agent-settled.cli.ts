import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

export default defineCliHook(
  (context: WithRoot<PiPluginContext<undefined>, PiPluginContributions<undefined>>) =>
    context.root.events!['agent_settled']!,
);
