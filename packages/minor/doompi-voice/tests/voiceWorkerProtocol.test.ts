import { describe, expect, it } from 'vitest';
import {
  parseVoiceWorkerCommand,
  parseVoiceWorkerEvent,
  VOICE_WORKER_PROTOCOL_VERSION,
} from '../src/services/voiceWorkerProtocol.ts';

const initialize = {
  version: VOICE_WORKER_PROTOCOL_VERSION,
  sequence: 0,
  kind: 'initialize',
  spoolDirectory: '/private/voice',
  activityHz: 8,
} as const;

describe('voice worker protocol', () => {
  it('accepts exact versioned control messages', () => {
    expect(parseVoiceWorkerCommand(initialize)).toEqual(initialize);
    expect(
      parseVoiceWorkerEvent({
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 1,
        kind: 'transcript-candidate',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        revision: 2,
        transcript: 'one, two, three',
        final: true,
        evidence: {
          durationMs: 800,
          voicedMs: 500,
          classifierSpeechMs: 400,
          rmsDbfs: -35,
          peakDbfs: -20,
          signalVariationDb: 8,
          nonZeroRatio: 0.7,
          gapCount: 0,
          playbackOverlapMs: 0,
          classifier: 'host',
          asr: {
            noSpeechProbability: 0.1,
            averageLogProbability: -0.3,
            compressionRatio: 1.2,
            segmentDurationMs: 800,
            speechDurationMs: 720,
          },
        },
      }),
    ).toMatchObject({ kind: 'transcript-candidate', revision: 2, transcript: 'one, two, three' });
  });

  it.each([
    { ...initialize, pcm: new Int16Array([1, 2]) },
    { ...initialize, wav: new ArrayBuffer(8) },
    { ...initialize, nested: { buffer: [1, 2] } },
  ])('rejects raw audio and binary payloads', (message) => {
    expect(() => parseVoiceWorkerCommand(message)).toThrow(/binary audio|must not contain/u);
  });

  it('rejects unknown fields and protocol versions', () => {
    expect(() => parseVoiceWorkerCommand({ ...initialize, unexpected: true })).toThrow('Unexpected');
    expect(() => parseVoiceWorkerCommand({ ...initialize, version: 2 })).toThrow('Unsupported');
  });

  it.each([
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 1,
      kind: 'begin-capture',
      sessionId: 'session-1',
      captureId: 'capture-1',
      mode: 'manual',
      turnId: 'turn-1',
      config: {
        engine: 'mlx-whisper',
        language: 'auto',
        recorder: { device: 'none:default' },
        adapters: { 'mlx-whisper': { model: { id: 'mlx-community/whisper-large-v3-turbo' } } },
      },
      maxDurationMs: 300_000,
      utteranceIdleMs: 3_000,
      transcriptionTimeoutMs: 15_000,
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 2,
      kind: 'finalize-capture',
      sessionId: 'session-1',
      captureId: 'capture-1',
      reason: 'explicit-stop',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 3,
      kind: 'cancel-capture',
      sessionId: 'session-1',
      captureId: 'capture-1',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 4,
      kind: 'acknowledge-candidate',
      sessionId: 'session-1',
      turnId: 'turn-1',
      revision: 1,
      outcome: 'committed',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 5,
      kind: 'playback-state',
      sessionId: 'session-1',
      playbackGeneration: 2,
      active: true,
      referenceText: 'The plan is ready',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 6,
      kind: 'confirm-barge-in',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      playbackGeneration: 2,
      outcome: 'promote',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 7,
      kind: 'shutdown',
      reason: 'session-shutdown',
    },
  ] as const)('parses command $kind', (command) => {
    expect(parseVoiceWorkerCommand(command)).toEqual(command);
  });

  it.each([
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 2,
      kind: 'heartbeat',
      workerUptimeMs: 1_000,
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 3,
      kind: 'capture-state',
      sessionId: 'session-1',
      captureId: 'capture-1',
      state: 'listening',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 4,
      kind: 'activity',
      sessionId: 'session-1',
      captureId: 'capture-1',
      state: 'speech',
      elapsedMs: 3_000,
      levelDbfs: -42,
      speechProbability: 0.81,
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 5,
      kind: 'endpoint-reached',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 6,
      kind: 'candidate-acknowledged',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 2,
      outcome: 'committed',
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 7,
      kind: 'barge-in-evidence',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      playbackGeneration: 2,
      evidence: {
        exactStopCommand: false,
        intentionalAddress: false,
        residualTokenCount: 4,
        residualRatio: 0.5,
        voicedMs: 800,
        peakDbAboveNoise: 12,
        signalVariationDb: 5,
        narrationSimilarity: 0.2,
      },
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 8,
      kind: 'failure',
      code: 'recorder_gap',
      recoverable: true,
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 2,
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 9,
      kind: 'drained',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 2,
    },
    {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 10,
      kind: 'recovered',
      sessionId: 'session-1',
      turnId: 'turn-1',
      revision: 2,
      gapCount: 1,
    },
  ] as const)('parses event $kind', (event) => {
    expect(parseVoiceWorkerEvent(event)).toEqual(event);
  });

  it('rejects invalid scalar fields and unsupported discriminants', () => {
    expect(() => parseVoiceWorkerCommand({ ...initialize, sequence: -1 })).toThrow('non-negative integer');
    expect(() => parseVoiceWorkerCommand({ ...initialize, activityHz: Number.NaN })).toThrow('finite number');
    expect(() => parseVoiceWorkerCommand({ ...initialize, kind: 'unknown' })).toThrow('Unsupported');
    expect(() =>
      parseVoiceWorkerEvent({
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 0,
        kind: 'ready',
        capabilities: [1],
      }),
    ).toThrow('capabilities');
  });
});
