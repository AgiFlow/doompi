import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { createLoopPiRuntime } from '../tui/loopRuntime';
import { createLoopCommands } from '../controllers/loopCommand';
import { PACKAGE_SOURCE } from '../constants/piLoop';
export const loopExtension = definePiExtension(PACKAGE_SOURCE, ({ pi }) => {
  const runtime = createLoopPiRuntime(pi);
  return {
    services: runtime.services,
    events: { agent_settled: runtime.onAgentSettled },
    commands: createLoopCommands(runtime.handlers),
    minorModes: runtime.minorModes,
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
