import { defineCliCommand, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import type { GoalExtensionDependencies } from '../../../../../types/extension';
export default defineCliCommand(
  (context: WithRoot<PiPluginContext<GoalExtensionDependencies>, PiPluginContributions<GoalExtensionDependencies>>) =>
    context.root.commands![0]!,
);
