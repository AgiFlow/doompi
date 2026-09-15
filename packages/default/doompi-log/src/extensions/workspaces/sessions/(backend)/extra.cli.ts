import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import { createPiTelemetryRuntime } from '../../../../controllers/piTelemetry';
import { createLogViewRuntime } from '../../../../tui/logRuntime';
import type { PiTelemetryExtensionOptions } from '../../../../types/piTelemetry';
export default ({ context, options }: PiPluginContext<PiTelemetryExtensionOptions>) => {
  const view = createLogViewRuntime((ctx) => telemetry.waitForSession(ctx), options);
  const telemetry = createPiTelemetryRuntime(context, view.telemetryOptions, true);
  let shutdown: Promise<void> | undefined;
  return {
    services: view.services,
    commands: view.commands,
    events: {
      ...telemetry.events,
      session_shutdown: (event, ctx) => (shutdown ??= telemetry.finishSession(event.reason, ctx)),
    },
    async onDispose() {
      view.onDispose();
      await telemetry.onDispose();
    },
  } satisfies PiPluginContributions;
};
