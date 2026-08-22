import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import {
  type AutonomousTurnIdentity,
  type AutonomousVoiceEffect,
  autonomousVoiceMachine,
  autonomousVoiceState,
} from '../src/services/autonomousVoiceMachine.ts';

const firstTurn: AutonomousTurnIdentity = {
  sessionId: 'session-1',
  captureId: 'capture-1',
  turnId: 'turn-1',
};

function harness() {
  const effects: AutonomousVoiceEffect[] = [];
  const actor = createActor(autonomousVoiceMachine);
  actor.on('*', (effect) => effects.push(effect));
  actor.start();
  return { actor, effects };
}

function enable(h: ReturnType<typeof harness>): void {
  h.actor.send({ type: 'ENABLE_REQUESTED', sessionId: firstTurn.sessionId });
  h.actor.send({ type: 'ENABLE_SUCCEEDED', ...firstTurn });
  h.actor.send({ type: 'CAPTURE_READY', ...firstTurn });
}

function reachTranscribing(h: ReturnType<typeof harness>): void {
  enable(h);
  h.actor.send({ type: 'SPEECH_CONFIRMED', ...firstTurn });
  h.actor.send({ type: 'ENDPOINT_REACHED', ...firstTurn });
  h.actor.send({ type: 'CAPTURE_PROCESSING', ...firstTurn });
}

function completeAcceptedTurn(h: ReturnType<typeof harness>): void {
  h.actor.send({ type: 'TRANSCRIPTION_SUCCEEDED', ...firstTurn, revision: 1, transcript: 'run tests' });
  h.actor.send({ type: 'TRANSCRIPT_ACCEPTED', ...firstTurn, revision: 1, text: 'run tests' });
  h.actor.send({ type: 'DELIVERY_SUCCEEDED', ...firstTurn, revision: 1 });
  h.actor.send({ type: 'CANDIDATE_ACKNOWLEDGED', ...firstTurn, revision: 1 });
}

afterEach(() => vi.useRealTimers());

describe('autonomous voice XState lifecycle', () => {
  it('processes an endpoint once and starts exactly one next turn', () => {
    const h = harness();
    enable(h);
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');

    h.actor.send({ type: 'SPEECH_CONFIRMED', ...firstTurn });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('speech');
    h.actor.send({ type: 'ENDPOINT_REACHED', ...firstTurn });
    h.actor.send({ type: 'CAPTURE_DRAINED', ...firstTurn, revision: 1 });
    completeAcceptedTurn(h);

    expect(h.actor.getSnapshot().matches({ active: { capture: 'startingNextTurn' } })).toBe(true);
    expect(h.effects.filter((effect) => effect.type === 'effect.finalizeCapture')).toEqual([
      { type: 'effect.finalizeCapture', ...firstTurn, reason: 'endpoint' },
    ]);
    expect(h.effects.filter((effect) => effect.type === 'effect.deliver')).toEqual([
      { type: 'effect.deliver', ...firstTurn, revision: 1, text: 'run tests' },
    ]);
    expect(h.effects.filter((effect) => effect.type === 'effect.acknowledge')).toEqual([
      { type: 'effect.acknowledge', ...firstTurn, revision: 1, outcome: 'committed' },
    ]);
    expect(h.effects.filter((effect) => effect.type === 'effect.prepareNextTurn')).toEqual([
      { type: 'effect.prepareNextTurn', sessionId: firstTurn.sessionId },
    ]);

    const secondTurn = { sessionId: firstTurn.sessionId, captureId: 'capture-2', turnId: 'turn-2' };
    h.actor.send({ type: 'NEXT_TURN_READY', ...secondTurn });
    h.actor.send({ type: 'CAPTURE_READY', ...secondTurn });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');
    expect(h.effects.filter((effect) => effect.type === 'effect.beginCapture')).toHaveLength(2);
  });

  it('rotates an idle capture at its duration boundary without failing or transcribing', () => {
    const h = harness();
    enable(h);
    h.actor.send({
      type: 'CAPTURE_DURATION_LIMIT_REACHED',
      sessionId: firstTurn.sessionId,
      captureId: 'stale-capture',
      turnId: firstTurn.turnId,
    });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');

    h.actor.send({ type: 'CAPTURE_DURATION_LIMIT_REACHED', ...firstTurn });

    expect(h.actor.getSnapshot().matches({ active: { capture: 'startingNextTurn' } })).toBe(true);
    expect(h.effects).toContainEqual({ type: 'effect.cancelCapture', ...firstTurn });
    expect(h.effects).toContainEqual({ type: 'effect.prepareNextTurn', sessionId: firstTurn.sessionId });
    expect(h.effects.some((effect) => effect.type === 'effect.finalizeCapture')).toBe(false);
    expect(h.effects.some((effect) => effect.type === 'effect.reportFailure')).toBe(false);
  });

  it('finalizes confirmed speech when its capture reaches the duration boundary', () => {
    const h = harness();
    enable(h);
    h.actor.send({ type: 'SPEECH_CONFIRMED', ...firstTurn });

    h.actor.send({ type: 'CAPTURE_DURATION_LIMIT_REACHED', ...firstTurn });

    expect(h.actor.getSnapshot().matches({ active: { capture: 'finalizing' } })).toBe(true);
    expect(h.effects).toContainEqual({ type: 'effect.finalizeCapture', ...firstTurn, reason: 'duration-limit' });
    expect(h.effects.some((effect) => effect.type === 'effect.cancelCapture')).toBe(false);
    expect(h.effects.some((effect) => effect.type === 'effect.reportFailure')).toBe(false);
  });

  it('toggles off from silence without launching transcription', () => {
    const h = harness();
    enable(h);

    h.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });

    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('stopping');
    expect(h.effects).toContainEqual({ type: 'effect.abortPlayback' });
    expect(h.effects).toContainEqual({ type: 'effect.stop', sessionId: firstTurn.sessionId, mode: 'graceful' });
    h.actor.send({ type: 'STOP_COMPLETED' });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('off');
  });

  it('gracefully finishes confirmed speech after toggle-off without starting another turn', () => {
    const h = harness();
    enable(h);
    h.actor.send({ type: 'SPEECH_CONFIRMED', ...firstTurn });

    h.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });

    expect(h.actor.getSnapshot().matches({ active: { capture: 'finalizing' } })).toBe(true);
    expect(h.effects.filter((effect) => effect.type === 'effect.finalizeCapture')).toEqual([
      { type: 'effect.finalizeCapture', ...firstTurn, reason: 'toggle-off' },
    ]);
    h.actor.send({ type: 'CAPTURE_DRAINED', ...firstTurn, revision: 1 });
    completeAcceptedTurn(h);
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('stopping');
    expect(h.effects.some((effect) => effect.type === 'effect.prepareNextTurn')).toBe(false);
  });

  it('does not start a second finalization when toggle-off arrives during ASR', () => {
    const h = harness();
    reachTranscribing(h);

    h.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });
    h.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });

    expect(h.actor.getSnapshot().matches({ active: { capture: 'transcribing' } })).toBe(true);
    expect(h.actor.getSnapshot().context.stopRequested).toBe(true);
    expect(h.effects.filter((effect) => effect.type === 'effect.finalizeCapture')).toHaveLength(1);
    completeAcceptedTurn(h);
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('stopping');
  });

  it('acknowledges an empty final and restarts unless stopping', () => {
    const active = harness();
    reachTranscribing(active);
    active.actor.send({ type: 'TRANSCRIPTION_EMPTY', ...firstTurn, revision: 1 });
    expect(active.effects).toContainEqual({
      type: 'effect.acknowledge',
      ...firstTurn,
      revision: 1,
      outcome: 'discarded',
    });
    active.actor.send({ type: 'CANDIDATE_ACKNOWLEDGED', ...firstTurn, revision: 1 });
    expect(active.actor.getSnapshot().matches({ active: { capture: 'startingNextTurn' } })).toBe(true);

    const stopping = harness();
    reachTranscribing(stopping);
    stopping.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });
    stopping.actor.send({ type: 'TRANSCRIPTION_EMPTY', ...firstTurn, revision: 1 });
    stopping.actor.send({ type: 'CANDIDATE_ACKNOWLEDGED', ...firstTurn, revision: 1 });
    expect(autonomousVoiceState(stopping.actor.getSnapshot())).toBe('stopping');
  });

  it('ignores stale capture, revision, and playback events', () => {
    const h = harness();
    enable(h);
    h.actor.send({
      type: 'SPEECH_CONFIRMED',
      sessionId: firstTurn.sessionId,
      captureId: 'stale-capture',
      turnId: firstTurn.turnId,
    });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');

    h.actor.send({ type: 'PLAYBACK_STARTED', sessionId: firstTurn.sessionId, playbackGeneration: 2 });
    h.actor.send({ type: 'PLAYBACK_ENDED', sessionId: firstTurn.sessionId, playbackGeneration: 1 });
    expect(h.actor.getSnapshot().matches({ active: { playback: 'playing' } })).toBe(true);
    expect(h.effects.filter((effect) => effect.type === 'effect.setPlaybackGate')).toEqual([
      {
        type: 'effect.setPlaybackGate',
        sessionId: firstTurn.sessionId,
        playbackGeneration: 2,
        active: true,
      },
    ]);
  });

  it('models playback and the bounded echo tail as a parallel region', async () => {
    vi.useFakeTimers();
    const h = harness();
    enable(h);
    h.actor.send({ type: 'PLAYBACK_STARTED', sessionId: firstTurn.sessionId, playbackGeneration: 1 });
    expect(h.actor.getSnapshot().matches({ active: { playback: 'playing' } })).toBe(true);
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');

    h.actor.send({ type: 'PLAYBACK_ENDED', sessionId: firstTurn.sessionId, playbackGeneration: 1 });
    expect(h.actor.getSnapshot().matches({ active: { playback: 'echoTail' } })).toBe(true);
    await vi.advanceTimersByTimeAsync(799);
    expect(h.actor.getSnapshot().matches({ active: { playback: 'echoTail' } })).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.actor.getSnapshot().matches({ active: { playback: 'silent' } })).toBe(true);
  });

  it('authorizes narration interruption only for independently ranked semantic evidence', () => {
    const h = harness();
    enable(h);
    h.actor.send({
      type: 'PLAYBACK_STARTED',
      sessionId: firstTurn.sessionId,
      playbackGeneration: 3,
      referenceText: 'The plan is ready',
    });
    h.actor.send({
      type: 'BARGE_IN_EVIDENCE',
      ...firstTurn,
      playbackGeneration: 3,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: false,
        residualTokenCount: 4,
        residualRatio: 0.5,
        voicedMs: 1_200,
        peakDbAboveNoise: 30,
        signalVariationDb: 20,
        narrationSimilarity: 0,
      },
    });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');
    expect(h.effects.some((effect) => effect.type === 'effect.confirmBargeIn')).toBe(false);

    h.actor.send({
      type: 'BARGE_IN_EVIDENCE',
      ...firstTurn,
      playbackGeneration: 3,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: true,
        residualTokenCount: 4,
        residualRatio: 0.5,
        voicedMs: 800,
        peakDbAboveNoise: 12,
        signalVariationDb: 5,
        narrationSimilarity: 0.2,
      },
    });

    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('speech');
    expect(h.effects).toContainEqual({
      type: 'effect.confirmBargeIn',
      ...firstTurn,
      playbackGeneration: 3,
      outcome: 'promote',
    });
    expect(h.effects).toContainEqual({ type: 'effect.abortPlayback' });
    expect(h.effects).toContainEqual({
      type: 'effect.setPlaybackGate',
      sessionId: firstTurn.sessionId,
      playbackGeneration: 3,
      active: true,
      referenceText: 'The plan is ready',
    });
  });

  it('discards command-only stop overlap instead of promoting narration tail audio', () => {
    const h = harness();
    enable(h);
    h.actor.send({
      type: 'PLAYBACK_STARTED',
      sessionId: firstTurn.sessionId,
      playbackGeneration: 4,
      referenceText: 'The latest commit is four four eight',
    });
    h.actor.send({
      type: 'BARGE_IN_EVIDENCE',
      ...firstTurn,
      playbackGeneration: 4,
      evidence: {
        exactStopCommand: true,
        residualTokenCount: 2,
        residualRatio: 0.25,
        voicedMs: 600,
        peakDbAboveNoise: 10,
        signalVariationDb: 4,
        narrationSimilarity: 0.5,
      },
    });

    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('listening');
    expect(h.effects).toContainEqual({
      type: 'effect.confirmBargeIn',
      ...firstTurn,
      playbackGeneration: 4,
      outcome: 'discard',
    });
    expect(h.effects).toContainEqual({ type: 'effect.abortPlayback' });
  });

  it('hard-stops resources before entering off at the graceful-stop deadline', async () => {
    vi.useFakeTimers();
    const h = harness();
    enable(h);
    h.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('stopping');
    expect(h.effects).toContainEqual({ type: 'effect.stop', sessionId: firstTurn.sessionId, mode: 'hard' });
    expect(h.effects).toContainEqual({
      type: 'effect.reportFailure',
      failure: { code: 'graceful_stop_timed_out', recoverable: false },
    });
    h.actor.send({ type: 'STOP_COMPLETED' });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('off');
  });

  it('starts the same 20-second deadline when toggled off during a hung transcription', async () => {
    vi.useFakeTimers();
    const h = harness();
    reachTranscribing(h);
    h.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.actor.getSnapshot().matches({ active: { capture: 'transcribing' } })).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('stopping');
    expect(h.effects.filter((effect) => effect.type === 'effect.finalizeCapture')).toHaveLength(1);
    expect(h.effects).toContainEqual({ type: 'effect.stop', sessionId: firstTurn.sessionId, mode: 'hard' });
  });

  it('reports functional failures and requires resource cleanup before off', () => {
    const h = harness();
    h.actor.send({ type: 'ENABLE_REQUESTED', sessionId: firstTurn.sessionId });
    h.actor.send({ type: 'ENABLE_FAILED', sessionId: firstTurn.sessionId, code: 'worker_unavailable' });

    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('failed');
    expect(h.effects).toContainEqual({
      type: 'effect.reportFailure',
      failure: { code: 'worker_unavailable', recoverable: false },
    });
    expect(h.effects).toContainEqual({ type: 'effect.stop', sessionId: firstTurn.sessionId, mode: 'hard' });
    h.actor.send({ type: 'STOP_COMPLETED' });
    expect(autonomousVoiceState(h.actor.getSnapshot())).toBe('off');
  });
});
