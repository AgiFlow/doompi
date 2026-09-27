import type { BackgroundWorkSummary } from '../backgroundWorkGate';

export type AutostopEventAttributes = Record<string, string | number | boolean>;

/** The slice of Doom telemetry this service writes to. */
export interface AutostopTelemetrySink {
  recordEvent(event: string, attributes?: AutostopEventAttributes): Promise<void>;
  shutdown(): Promise<void>;
}

export interface AutostopDiagnosticsOptions {
  readonly telemetry: AutostopTelemetrySink;
  readonly now: () => number;
  readonly reportIntervalMs?: number;
  readonly flushTimeoutMs?: number;
}

/** Told about each auto-stop decision, so a session that never stops leaves a record of why. */
export interface AutostopDiagnostics {
  waiting(work: BackgroundWorkSummary): void;
  stoodDown(): void;
  shutdownRequested(): void;
  /** The user or agent is active again; the next wait starts fresh. */
  reset(): void;
  /** Flushes telemetry, bounded so it can delay exit but never prevent it. */
  dispose(): Promise<void>;
}
