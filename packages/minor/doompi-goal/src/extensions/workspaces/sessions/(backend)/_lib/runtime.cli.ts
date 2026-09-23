import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

import { createGoalPlugin } from '../../../../../services/goalPlugin';
import type { GoalExtensionDependencies } from '../../../../../types/extension';
const PACKAGE_SOURCE = '@agimon-ai/doompi-goal';

export default (({ pi, options }) => ({
  ...createGoalPlugin(pi, options, async (context, manager) =>
    (await import('../../../../../tui/goalHistoryOverlay')).openGoalHistoryOverlay(context, manager),
  ),
  resources: [
    {
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-goal',
          description:
            'Use Doom Pi Goal to start, budget, pause, resume, complete, block, and inspect persistent repository goals.',
        },
      ],
    },
  ],
})) satisfies (context: PiPluginContext<GoalExtensionDependencies>) => PiPluginContributions<GoalExtensionDependencies>;
