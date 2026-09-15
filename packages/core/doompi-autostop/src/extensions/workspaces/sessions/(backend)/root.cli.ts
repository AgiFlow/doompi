import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { DEFAULT_AUTO_STOP_DELAYS } from '../../../../constants/idlePolicy';
import { createBackgroundWorkGate } from '../../../../services/backgroundWorkGate';
import type { AutoStopDelays } from '../../../../services/idlePolicy/type';
import { createIdleShutdown } from '../../../../services/idleShutdown';
export default defineRoot(({ options }: PiPluginContext<AutoStopDelays>) => {
  const backgroundWork = createBackgroundWorkGate();
  const watch = createIdleShutdown(options ?? DEFAULT_AUTO_STOP_DELAYS, (context) =>
    backgroundWork.hasActiveWork(context.sessionManager.getSessionId()),
  );
  return { value: watch, services: [backgroundWork.plugin], onDispose: watch.cancel };
});
