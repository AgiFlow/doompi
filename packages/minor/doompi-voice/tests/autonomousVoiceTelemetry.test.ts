import { createActor } from 'xstate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutonomousVoiceTelemetry,
  type AutonomousVoiceTelemetrySink,
  autonomousVoiceTelemetryStage,
} from '../src/services/autonomousVoiceTelemetry.ts';
import { autonomousVoiceMachine } from '../src/services/autonomousVoiceMachine.ts';

const identity = {
  sessionId: 'session-1',
  captureId: 'capture-1',
  turnId: 'turn-1',
};

afterEach(() => vi.restoreAllMocks());

describe('AutonomousVoiceTelemetry', () => {
  it('records correlated exact-stage durations without transcript content', () => {
    const recordEvent = vi.fn<AutonomousVoiceTelemetrySink['recordEvent']>();
    const telemetry = new AutonomousVoiceTelemetry({ recordEvent }, 100);
    const actor = createActor(autonomousVoiceMachine);
    actor.start();

    telemetry.observe(actor.getSnapshot(), 100);
    actor.send({ type: 'ENABLE_REQUESTED', sessionId: identity.sessionId });
    telemetry.observe(actor.getSnapshot(), 125);
    actor.send({ type: 'ENABLE_SUCCEEDED', ...identity });
    telemetry.observe(actor.getSnapshot(), 140);
    actor.send({ type: 'CAPTURE_READY', ...identity });
    telemetry.observe(actor.getSnapshot(), 150);
    actor.send({ type: 'SPEECH_CONFIRMED', ...identity });
    telemetry.observe(actor.getSnapshot(), 180);
    actor.send({ type: 'ENDPOINT_REACHED', ...identity });
    telemetry.observe(actor.getSnapshot(), 200);
    actor.send({ type: 'CAPTURE_DRAINED', ...identity, revision: 7 });
    telemetry.observe(actor.getSnapshot(), 230);

    expect(recordEvent.mock.calls).toEqual([
      [
        'doom_voice.autonomous_transition',
        {
          from_state: 'off',
          to_state: 'enabling',
          stage_duration_ms: 25,
          session_id: identity.sessionId,
          stop_requested: false,
        },
      ],
      [
        'doom_voice.autonomous_transition',
        {
          from_state: 'enabling',
          to_state: 'startingCapture',
          stage_duration_ms: 15,
          session_id: identity.sessionId,
          capture_id: identity.captureId,
          turn_id: identity.turnId,
          stop_requested: false,
        },
      ],
      [
        'doom_voice.autonomous_transition',
        {
          from_state: 'startingCapture',
          to_state: 'listening',
          stage_duration_ms: 10,
          session_id: identity.sessionId,
          capture_id: identity.captureId,
          turn_id: identity.turnId,
          stop_requested: false,
        },
      ],
      [
        'doom_voice.autonomous_transition',
        {
          from_state: 'listening',
          to_state: 'speech',
          stage_duration_ms: 30,
          session_id: identity.sessionId,
          capture_id: identity.captureId,
          turn_id: identity.turnId,
          stop_requested: false,
        },
      ],
      [
        'doom_voice.autonomous_transition',
        {
          from_state: 'speech',
          to_state: 'finalizing',
          stage_duration_ms: 20,
          session_id: identity.sessionId,
          capture_id: identity.captureId,
          turn_id: identity.turnId,
          stop_requested: false,
        },
      ],
      [
        'doom_voice.autonomous_transition',
        {
          from_state: 'finalizing',
          to_state: 'transcribing',
          stage_duration_ms: 30,
          session_id: identity.sessionId,
          capture_id: identity.captureId,
          turn_id: identity.turnId,
          revision: 7,
          stop_requested: false,
        },
      ],
    ]);
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain('transcript');
    expect(autonomousVoiceTelemetryStage(actor.getSnapshot())).toBe('transcribing');
  });

  it('records typed failures with the current stage and correlation', () => {
    const recordEvent = vi.fn<AutonomousVoiceTelemetrySink['recordEvent']>();
    const telemetry = new AutonomousVoiceTelemetry({ recordEvent }, 0);
    const actor = createActor(autonomousVoiceMachine);
    actor.start();
    actor.send({ type: 'ENABLE_REQUESTED', sessionId: identity.sessionId });
    telemetry.observe(actor.getSnapshot(), 1);
    actor.send({ type: 'ENABLE_SUCCEEDED', ...identity });
    telemetry.observe(actor.getSnapshot(), 2);
    actor.send({ type: 'CAPTURE_READY', ...identity });
    telemetry.observe(actor.getSnapshot(), 3);

    telemetry.recordEffect({
      type: 'effect.reportFailure',
      failure: { code: 'recorder_stale', recoverable: false },
    });

    expect(recordEvent).toHaveBeenLastCalledWith('doom_voice.autonomous_failure', {
      state: 'listening',
      session_id: identity.sessionId,
      capture_id: identity.captureId,
      turn_id: identity.turnId,
      code: 'recorder_stale',
      recoverable: false,
    });
  });

  it('isolates synchronous throws and asynchronous telemetry rejection', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const actor = createActor(autonomousVoiceMachine);
    actor.start();
    actor.send({ type: 'ENABLE_REQUESTED', sessionId: identity.sessionId });
    const synchronous = new AutonomousVoiceTelemetry({
      recordEvent: () => {
        throw new Error('sink unavailable');
      },
    });
    const asynchronous = new AutonomousVoiceTelemetry({
      recordEvent: async () => Promise.reject(new Error('export unavailable')),
    });

    expect(() => synchronous.observe(actor.getSnapshot(), 1)).not.toThrow();
    expect(() => asynchronous.observe(actor.getSnapshot(), 1)).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith('Autonomous voice telemetry export failed (Error).');
  });
});
