import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';

import { DEFAULT_AUTO_STOP_DELAYS } from '../../../../constants/idlePolicy';
import { createAutostopDiagnostics } from '../../../../services/autostopDiagnostics';
import { createBackgroundWorkGate } from '../../../../services/backgroundWorkGate';
import type { AutoStopDelays } from '../../../../services/idlePolicy/type';
import { createIdleShutdown } from '../../../../services/idleShutdown';
export default defineRoot(({ options }: PiPluginContext<AutoStopDelays>) => {
  const backgroundWork = createBackgroundWorkGate();
  const diagnostics = createAutostopDiagnostics({
    telemetry: createDoomTelemetry({
      serviceName: 'doom-autostop',
      packageName: '@agimon-ai/doompi-autostop',
      enableLogs: true,
      enableTraces: false,
    }),
    now: Date.now,
  });
  const watch = createIdleShutdown(
    options ?? DEFAULT_AUTO_STOP_DELAYS,
    (context) => backgroundWork.inspect(context.sessionManager.getSessionId()),
    diagnostics,
  );
  return {
    value: watch,
    services: [backgroundWork.plugin],
    onDispose: async () => {
      watch.cancel();
      await diagnostics.dispose();
    },
  };
});
