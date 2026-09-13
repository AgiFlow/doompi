import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createGoalPlugin } from '../controllers/goalPlugin';
import type { GoalExtensionDependencies } from '../types/extension';
const PACKAGE_SOURCE = '@agimon-ai/doompi-goal';
export const goalExtension = definePiExtension<GoalExtensionDependencies>(PACKAGE_SOURCE, ({ pi, options }) => ({
  ...createGoalPlugin(pi, options, async (context, manager) =>
    (await import('../tui/goalHistoryOverlay')).openGoalHistoryOverlay(context, manager),
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
}));
export default goalExtension;
