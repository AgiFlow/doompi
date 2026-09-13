import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { DEFAULT_AUTO_STOP_DELAYS } from '../constants/idlePolicy';
import { createBackgroundWorkGate } from '../services/backgroundWorkGate';
import type { AutoStopDelays } from '../services/idlePolicy/type';
import { createIdleShutdown } from '../services/idleShutdown';
export const autoStopExtension = definePiExtension<AutoStopDelays>('@agimon-ai/doompi-autostop', ({ options }) => {
  const backgroundWork = createBackgroundWorkGate();
  const watch = createIdleShutdown(options ?? DEFAULT_AUTO_STOP_DELAYS, (context) =>
    backgroundWork.hasActiveWork(context.sessionManager.getSessionId()),
  );
  return {
    services: [backgroundWork.plugin],
    events: {
      input: watch.cancel,
      agent_start: watch.cancel,
      agent_settled: (_event, context) => watch.settled(context),
    },
    onDispose: watch.cancel,
  };
});
export default autoStopExtension;
