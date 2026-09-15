import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import { createPlanModeRuntime } from '../../../../controllers/planMode';

export default (({ pi }) => ({
  ...createPlanModeRuntime(pi),
  resources: [
    {
      source: '@agimon-ai/doompi-plan',
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-plan',
          description:
            'Use Doom Pi Plan to draft reviewable normal, debug, or Fable-assisted plans, persist them, and exit safely.',
        },
      ],
    },
  ],
})) satisfies (context: PiPluginContext<undefined>) => PiPluginContributions<undefined>;
