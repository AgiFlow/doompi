import { defineCliTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions, PiToolContribution } from '@agimon-ai/doompi-core/piExtension';

import type { GoalExtensionDependencies } from '../../../../../types/extension';
export default defineCliTool(
  (context: WithRoot<PiPluginContext<GoalExtensionDependencies>, PiPluginContributions<GoalExtensionDependencies>>) =>
    (context.root.tools as readonly PiToolContribution[])[0]!,
);
