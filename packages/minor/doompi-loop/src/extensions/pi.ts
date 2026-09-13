import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { piMinorModes } from '@agimon-ai/doompi-minor-mode';

import { PACKAGE_SOURCE } from '../constants/piLoop';
import { createLoopCommands } from '../controllers/loopCommand';
import { createLoopPiRuntime } from '../tui/loopRuntime';
export const loopExtension = definePiExtension(PACKAGE_SOURCE, ({ pi }) => {
  const runtime = createLoopPiRuntime(pi);
  return {
    services: [...(runtime.services ?? []), piMinorModes(runtime.minorModes)],
    events: { agent_settled: runtime.onAgentSettled },
    commands: createLoopCommands(runtime.handlers),

    onDispose: () => runtime.onDispose(),
    resources: [
      {
        source: PACKAGE_SOURCE,
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-use-loop',
            description: 'Use Doom Pi Loop to start, inspect, and stop session-scoped recurring prompts safely.',
          },
        ],
      },
    ],
  };
});
export default loopExtension;
