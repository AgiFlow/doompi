import type {
  AutonomousVoiceEffect,
  AutonomousVoiceFailure,
  AutonomousVoiceSnapshot,
} from './autonomousVoiceMachine.ts';

export type AutonomousVoiceTelemetryValue = string | number | boolean;

export type AutonomousVoiceTelemetryStage =
  | 'off'
  | 'enabling'
  | 'startingCapture'
  | 'listening'
  | 'speech'
  | 'finalizing'
  | 'transcribing'
  | 'applyingPolicy'
  | 'delivering'
  | 'acknowledging'
  | 'startingNextTurn'
  | 'stopping'
  | 'failed';

export interface AutonomousVoiceTelemetrySink {
  recordEvent(name: string, attributes: Readonly<Record<string, AutonomousVoiceTelemetryValue>>): void | Promise<void>;
}

type TelemetryAttributes = Readonly<Record<string, AutonomousVoiceTelemetryValue>>;

type CorrelationAttributes = Partial<{
  session_id: string;
  capture_id: string;
  turn_id: string;
  revision: number;
}>;

export function autonomousVoiceTelemetryStage(snapshot: AutonomousVoiceSnapshot): AutonomousVoiceTelemetryStage {
  if (snapshot.matches('off')) return 'off';
  if (snapshot.matches('enabling')) return 'enabling';
  if (snapshot.matches({ active: { capture: 'startingCapture' } })) return 'startingCapture';
  if (snapshot.matches({ active: { capture: 'listening' } })) return 'listening';
  if (snapshot.matches({ active: { capture: 'speech' } })) return 'speech';
  if (snapshot.matches({ active: { capture: 'finalizing' } })) return 'finalizing';
  if (snapshot.matches({ active: { capture: 'transcribing' } })) return 'transcribing';
  if (snapshot.matches({ active: { capture: 'applyingPolicy' } })) return 'applyingPolicy';
  if (snapshot.matches({ active: { capture: 'delivering' } })) return 'delivering';
  if (snapshot.matches({ active: { capture: 'acknowledging' } })) return 'acknowledging';
  if (snapshot.matches({ active: { capture: 'startingNextTurn' } })) return 'startingNextTurn';
  if (snapshot.matches('stopping')) return 'stopping';
  return 'failed';
}

export class AutonomousVoiceTelemetry {
  private previousStage: AutonomousVoiceTelemetryStage = 'off';
  private stageStartedAt: number;
  private correlation: CorrelationAttributes = {};
  private sinkFailureReported = false;

  public constructor(
    private readonly sink: AutonomousVoiceTelemetrySink,
    startedAt = Date.now(),
  ) {
    this.stageStartedAt = startedAt;
  }

  public observe(snapshot: AutonomousVoiceSnapshot, now: number): void {
    const stage = autonomousVoiceTelemetryStage(snapshot);
    const correlation = this.updateCorrelation(snapshot);
    if (stage === this.previousStage) return;
    this.record('doom_voice.autonomous_transition', {
      from_state: this.previousStage,
      to_state: stage,
      stage_duration_ms: Math.max(0, now - this.stageStartedAt),
      ...correlation,
      stop_requested: snapshot.context.stopRequested,
    });
    this.previousStage = stage;
    this.stageStartedAt = now;
    if (stage === 'off') this.correlation = {};
  }

  public recordEffect(effect: AutonomousVoiceEffect): void {
    if (effect.type === 'effect.reportFailure') this.recordFailure(effect.failure);
  }

  public recordFailure(failure: AutonomousVoiceFailure): void {
    this.record('doom_voice.autonomous_failure', {
      state: this.previousStage,
      ...this.correlation,
      code: failure.code,
      recoverable: failure.recoverable,
    });
  }

  private updateCorrelation(snapshot: AutonomousVoiceSnapshot): CorrelationAttributes {
    const context = snapshot.context;
    if (context.sessionId && context.sessionId !== this.correlation.session_id)
      this.correlation = { session_id: context.sessionId };
    if (context.captureId && context.captureId !== this.correlation.capture_id)
      this.correlation = {
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        capture_id: context.captureId,
      };
    if (context.turnId) this.correlation.turn_id = context.turnId;
    if (context.revision === undefined) delete this.correlation.revision;
    else this.correlation.revision = context.revision;
    return { ...this.correlation };
  }

  private record(name: string, attributes: TelemetryAttributes): void {
    try {
      void Promise.resolve(this.sink.recordEvent(name, attributes)).catch((error: unknown) =>
        this.reportSinkFailure(error),
      );
    } catch (error) {
      this.reportSinkFailure(error);
    }
  }

  private reportSinkFailure(error: unknown): void {
    if (this.sinkFailureReported) return;
    this.sinkFailureReported = true;
    const errorType = error instanceof Error ? error.name : typeof error;
    process.emitWarning(`Autonomous voice telemetry export failed (${errorType}).`);
  }
}
