import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createPiTelemetryRuntime } from '../controllers/piTelemetry';
import { createLogViewRuntime } from '../tui/logRuntime';
import type { PiTelemetryExtensionOptions } from '../types/piTelemetry';
import { PACKAGE_NAME } from '../constants/telemetry';
export const doomLogExtension = definePiExtension<PiTelemetryExtensionOptions>(PACKAGE_NAME, ({ context, options }) => {
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
  };
});
export default doomLogExtension;
