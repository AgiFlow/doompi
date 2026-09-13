import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { LogMetricsRecorder } from '../services/metrics';
import type { MetricsSource } from './metricsSource';
import type { SinkStatus } from './sinkStatus';
export type TelemetryFactory = NonNullable<DoomTelemetryOptions['telemetryFactory']>;
export type TelemetryAttributes = Record<string, string | number | boolean>;
export type RecordLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PiTelemetryExtensionOptions {
  allowFileFallback?: boolean;
  /** Overrides the telemetry service identity. */
  serviceName?: string;
  /** Overrides the leader contribution owner. */
  leaderSource?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: TelemetryFactory;
  /** Receives every sanitized record, whether or not a sink is live. */
  metrics?: LogMetricsRecorder;
  /** Called once the sink backend is resolved, so the overlay can report it. */
  onSinkStatus?: (status: SinkStatus | undefined) => void;
  /** Overrides the sink-history transport; injected in tests. */
  metricsSource?: MetricsSource;
  /** Receives telemetry lifecycle failures without writing into the TUI. */
  onDiagnostic?: (message: string) => void;
}

export interface PiTelemetryRuntimeHandle {
  waitForSession(ctx: ExtensionContext): Promise<void>;
  finishSession(reason: string, ctx: ExtensionContext): Promise<void>;
}
