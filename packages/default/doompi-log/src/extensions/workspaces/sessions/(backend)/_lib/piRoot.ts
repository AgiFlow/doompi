import { DOOM_CORDIS_SESSION_SERVICE, requireDoomCordisSession } from '@agimon-ai/doompi-core/cordisHost';
import { createPiHelpToolGate } from '@agimon-ai/doompi-core/help';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import type { ExtensionContext, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import { DIAGNOSE_AGENT_NAME } from '../../../../../constants/diagnostics';
import { PACKAGE_NAME, SERVICE_NAME } from '../../../../../constants/telemetry';
import { createAgentDiagnosticsTool } from '../../../../../services/agentDiagnostics';
import { createPiTelemetryRuntime } from '../../../../../services/piTelemetry';
import { createLogViewRuntime } from '../../../../../tui/logRuntime';
import type { PiTelemetryExtensionOptions } from '../../../../../types/piTelemetry';
export const createLogPiRoot = ({ context, options }: PiPluginContext<PiTelemetryExtensionOptions>) => {
  let telemetry: ReturnType<typeof createPiTelemetryRuntime>;
  const view = createLogViewRuntime((ctx) => telemetry.waitForSession(ctx), options);
  telemetry = createPiTelemetryRuntime(context, view.telemetryOptions, true);
  let shutdown: Promise<void> | undefined;
  const gate = createPiHelpToolGate(PACKAGE_NAME, [DIAGNOSE_AGENT_NAME]);
  let session: ReturnType<typeof requireDoomCordisSession> | undefined;
  const bindSession: (typeof view.services)[number] = (cordis) => {
    cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (child) => {
      const current = requireDoomCordisSession(child);
      session = current;
      return () => {
        if (session === current) session = undefined;
      };
    });
  };
  return {
    value: {
      telemetry,
      view,
      diagnosticTool: createAgentDiagnosticsTool(
        () => {
          if (!session) throw new Error('Agent diagnostics require the current session.');
          return {
            sessionId: session.sessionId,
            options: {
              cwd: session.context.cwd,
              env: { ...(options?.env ?? process.env) },
              serviceName: options?.serviceName ?? SERVICE_NAME,
            },
          };
        },
        (signal) => gate.assertActive(DIAGNOSE_AGENT_NAME, signal),
      ),
      sessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) =>
        (shutdown ??= telemetry.finishSession(event.reason, ctx)),
    },
    services: [...gate.services, bindSession, ...view.services],
    onStart: gate.onStart,
    async onDispose() {
      await view.onDispose();
      await telemetry.onDispose();
    },
  };
};
export type LogPiScope = Awaited<ReturnType<typeof createLogPiRoot>>['value'];
