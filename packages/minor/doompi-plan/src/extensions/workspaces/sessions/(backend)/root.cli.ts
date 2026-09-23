import { defineRoot, type RootDeclaration } from '@agimon-ai/doompi-core/extensionFile';
import {
  definePiTool,
  type PiPluginContext,
  type PiPluginContributions,
  type PiToolDeclaration,
} from '@agimon-ai/doompi-core/piExtension';

import { createPlanModeRuntime } from '../../../../services/planMode';

type Scope = Omit<ReturnType<typeof createPlanModeRuntime>, 'tools'> & {
  readonly tools: readonly PiToolDeclaration[];
  readonly resources: NonNullable<PiPluginContributions['resources']>;
};

export default defineRoot((context: PiPluginContext<undefined>): RootDeclaration<Scope, PiPluginContext<undefined>> => {
  const runtime = createPlanModeRuntime(context.pi);
  const value = {
    ...runtime,
    tools: runtime.tools.map((tool) => definePiTool(tool)),
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
  };
  return {
    value,
    services: value.services,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
