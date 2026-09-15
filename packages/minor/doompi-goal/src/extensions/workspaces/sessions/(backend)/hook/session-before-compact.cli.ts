import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers, PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import type { GoalExtensionDependencies } from '../../../../../types/extension';
export default defineCliHook(
  (
    context: WithRoot<PiPluginContext<GoalExtensionDependencies>, PiPluginContributions<GoalExtensionDependencies>>,
  ): NonNullable<PiEventHandlers['session_before_compact']> => context.root.events!['session_before_compact']!,
);
