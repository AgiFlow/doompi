import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionContext, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import { createPiTelemetryRuntime } from '../../../../../services/piTelemetry';
import { createLogViewRuntime } from '../../../../../tui/logRuntime';
import type { PiTelemetryExtensionOptions } from '../../../../../types/piTelemetry';
export const createLogPiRoot = ({ context, options }: PiPluginContext<PiTelemetryExtensionOptions>) => {
  let telemetry: ReturnType<typeof createPiTelemetryRuntime>;
  const view = createLogViewRuntime((ctx) => telemetry.waitForSession(ctx), options);
  telemetry = createPiTelemetryRuntime(context, view.telemetryOptions, true);
  let shutdown: Promise<void> | undefined;
  return {
    value: {
      telemetry,
      view,
      sessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) =>
        (shutdown ??= telemetry.finishSession(event.reason, ctx)),
    },
    services: view.services,
    async onDispose() {
      await view.onDispose();
      await telemetry.onDispose();
    },
  };
};
export type LogPiScope = Awaited<ReturnType<typeof createLogPiRoot>>['value'];
