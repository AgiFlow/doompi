import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  DOOM_UI_HUB_SERVICE,
  type DoomUiHubService,
  requireDoomUiHub,
} from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { LogMetricsAggregator } from '../services/metrics';
import { createMetricsSource } from '../services/metricsSource';
import { isEnabled } from '../services/telemetryEnabled';
import { LogMetricsOverlayComponent, type LogMetricsView } from './logMetricsOverlay';
import type { SinkStatus } from '../types/sinkStatus';
import type { PiTelemetryExtensionOptions } from '../types/piTelemetry';
import type { MetricsSource, MetricsQuery } from '../types/metricsSource';
import {
  PACKAGE_NAME,
  SERVICE_NAME,
  DIAGNOSTICS_STDERR,
  LEADER_SOURCE,
  LOG_METRICS_COMMAND,
  LOG_METRICS_DESCRIPTION,
  HELP_GROUP_ORDER,
  HELP_GROUP_DETAIL,
} from '../constants/telemetry';
export function registerLogMetricsLeaderBinding(hub: DoomUiHubService, options: { source?: string } = {}): () => void {
  const contribution = hub.registerLeader({
    source: options.source ?? LEADER_SOURCE,
    bindings: [
      {
        id: 'log.metrics',
        path: [
          { key: 'h', label: 'help', detail: HELP_GROUP_DETAIL, order: HELP_GROUP_ORDER },
          { key: 'l', label: 'logs', detail: 'telemetry' },
        ],
        command: { name: LOG_METRICS_COMMAND },
      },
    ],
  });
  return () => contribution.dispose();
}

export async function openLogMetricsOverlay(
  ctx: ExtensionContext,
  getView: () => LogMetricsView,
  query?: MetricsQuery,
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new LogMetricsOverlayComponent(tui, theme, getView, done, query),
    {
      overlay: true,
      overlayOptions: {
        anchor: 'top-left',
        width: '100%',
        maxHeight: '100%',
        margin: 0,
      },
    },
  );
}

export function createLogViewRuntime(
  waitForSession: (ctx: ExtensionContext) => Promise<void>,
  options: PiTelemetryExtensionOptions = {},
) {
  const env = options.env ?? process.env;
  const metrics = new LogMetricsAggregator();
  // Built lazily so the history transports resolve their sink instance from the
  // same cwd and package identity the telemetry writer registers under; at
  // install time there is no ExtensionContext to read `cwd` from yet.
  let metricsSource = options.metricsSource;
  const resolveMetricsSource = (ctx: ExtensionContext): MetricsSource =>
    (metricsSource ??= createMetricsSource({
      env,
      cwd: ctx.cwd,
      packageName: PACKAGE_NAME,
      serviceName: options.serviceName ?? SERVICE_NAME,
    }));
  let active = true;
  let sink: SinkStatus | undefined;
  let lastDiagnostic: string | undefined;

  const telemetryOptions: PiTelemetryExtensionOptions = {
    ...options,
    metrics,
    // Always supply a sink so doom-telemetry never falls back to
    // process.emitWarning, which writes raw stderr over the TUI frame.
    // Diagnostics surface in the Log Metrics overlay instead.
    onDiagnostic: (message) => {
      if (!active) return;
      lastDiagnostic = message;
      if (options.onDiagnostic) options.onDiagnostic(message);
      else if (env.AGENT_OTEL_DIAGNOSTICS === DIAGNOSTICS_STDERR) process.emitWarning(message);
    },
    onSinkStatus: (status) => {
      if (!active) return;
      sink = status;
      options.onSinkStatus?.(status);
    },
  };

  return {
    telemetryOptions,
    onDispose: () => {
      active = false;
      sink = undefined;
      lastDiagnostic = undefined;
    },
    services: [
      (cordis: Context) => {
        cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) =>
          registerLogMetricsLeaderBinding(requireDoomUiHub(uiContext), { source: options.leaderSource }),
        );
      },
    ],
    commands: [
      [
        LOG_METRICS_COMMAND,
        {
          description: LOG_METRICS_DESCRIPTION,
          handler: async (_args, ctx) => {
            if (!active) return;
            await waitForSession(ctx);
            if (!active) return;
            const source = resolveMetricsSource(ctx);
            await openLogMetricsOverlay(
              ctx,
              () => ({
                disabled: isEnabled(env.AGENT_TELEMETRY_DISABLED) || isEnabled(env.OTEL_SDK_DISABLED),
                snapshot: metrics.snapshot(),
                sink,
                transport: source.lastTransport(),
                instance: source.instance?.(),
                lastDiagnostic,
              }),
              source.query,
            );
          },
        },
      ],
    ] satisfies readonly (readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]])[],
  };
}
