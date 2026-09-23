import { defineToolRestriction, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

import type { GoalExtensionDependencies } from '../../../../../types/extension';
export default defineToolRestriction(
  (context: WithRoot<PiPluginContext<GoalExtensionDependencies>, PiPluginContributions<GoalExtensionDependencies>>) =>
    context.root.toolRestrictions![0]!,
);
