import { describe, expect, it } from 'vitest';
import {
  AdaptiveVoiceActivityDetector,
  calculatePcmFrameDbfs,
  PCM_FRAME_BYTES,
  type VadConfiguration,
  type VadSegment,
} from '../src/exports';

const TEST_CONFIGURATION: VadConfiguration = {
  frameMs: 20,
  startupCalibrationMs: 0,
  preRollMs: 80,
  minimumVoicedMs: 40,
  trailingSilenceMs: 40,
  maximumSegmentMs: 200,
  bucketMs: 40,
  noiseMarginDb: 10,
  minimumThresholdDbfs: -50,
  maximumThresholdDbfs: -25,
  initialNoiseFloorDbfs: -60,
  noiseLearningRate: 0.2,
};

function pcmFrame(amplitude: number): Buffer {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(amplitude, offset);
  return frame;
}

function pushFrames(
  detector: AdaptiveVoiceActivityDetector,
  amplitudes: readonly number[],
  playbackOverlapMs = 0,
): VadSegment[] {
  const segments: VadSegment[] = [];
  for (const amplitude of amplitudes) {
    const result = detector.push(pcmFrame(amplitude), { playbackOverlapMs });
    if (result.segment) segments.push(result.segment);
  }
  return segments;
}

describe('adaptive voice activity detection', () => {
  it('calculates finite dBFS and negative infinity for digital silence', () => {
    expect(calculatePcmFrameDbfs(pcmFrame(0))).toBe(Number.NEGATIVE_INFINITY);
    expect(calculatePcmFrameDbfs(pcmFrame(16_384))).toBeCloseTo(-6.02, 1);
  });

  it('calibrates measured ambient before accepting speech and closes after production trailing silence', () => {
    const ambientAmplitude = 80;
    const detector = new AdaptiveVoiceActivityDetector();

    const calibrationResults = Array.from({ length: 25 }, () => detector.push(pcmFrame(ambientAmplitude)));
    const ambientResults = Array.from({ length: 25 }, () => detector.push(pcmFrame(ambientAmplitude)));
    const speechResults = Array.from({ length: 10 }, () => detector.push(pcmFrame(4_000)));
    const segments = pushFrames(
      detector,
      Array.from({ length: 30 }, () => ambientAmplitude),
    );

    expect(calibrationResults.every((result) => !result.speechStarted && !result.segment)).toBe(true);
    expect(ambientResults.every((result) => !result.speechStarted && !result.segment)).toBe(true);
    expect(speechResults.some((result) => result.speechStarted)).toBe(true);
    expect(detector.noiseFloorDbfs).toBeGreaterThan(-60);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.activityHistogram).toMatchObject({
      voicedMs: 200,
      trailingSilenceMs: 600,
      forcedClose: false,
    });
  });

  it('learns an above-floor startup baseline instead of treating stable room noise as speech', () => {
    const detector = new AdaptiveVoiceActivityDetector();
    const roomNoise = Array.from({ length: 25 }, () => detector.push(pcmFrame(128)));
    const speech = Array.from({ length: 8 }, () => detector.push(pcmFrame(4_000)));
    const segments = pushFrames(
      detector,
      Array.from({ length: 30 }, () => 128),
    );

    expect(roomNoise.every((result) => !result.speechStarted)).toBe(true);
    expect(speech.some((result) => result.speechStarted)).toBe(true);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.activityHistogram.forcedClose).toBe(false);
  });

  it('persists a running noise average and slowly rebases sustained stable noise', () => {
    const detector = new AdaptiveVoiceActivityDetector();
    pushFrames(
      detector,
      Array.from({ length: 25 }, () => 80),
    );
    const baseline = detector.noiseProfile;
    const elevatedNoise = Array.from({ length: 200 }, () => detector.push(pcmFrame(220)));
    const learned = detector.noiseProfile;
    const resumed = new AdaptiveVoiceActivityDetector(undefined, learned);

    expect(elevatedNoise.every((result) => !result.speechStarted)).toBe(true);
    expect(learned.averageDbfs).toBeGreaterThan(baseline.averageDbfs);
    expect(learned.observedMs).toBeGreaterThan(baseline.observedMs);
    expect(resumed.noiseProfile).toEqual(learned);
  });

  it('preserves speech that begins immediately during startup calibration', () => {
    const detector = new AdaptiveVoiceActivityDetector();

    const speechResults = Array.from({ length: 6 }, () => detector.push(pcmFrame(4_000)));
    const segments = pushFrames(
      detector,
      Array.from({ length: 30 }, () => 0),
    );

    expect(speechResults[0]).toMatchObject({ provisionalSpeechStarted: true, speechStarted: false });
    expect(speechResults.some((result) => result.speechStarted)).toBe(true);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.activityHistogram.voicedMs).toBe(120);
  });

  it('accepts quiet speech relative to a calibrated noise floor', () => {
    const detector = new AdaptiveVoiceActivityDetector();
    pushFrames(
      detector,
      Array.from({ length: 25 }, () => 80),
    );

    const speechResults = Array.from({ length: 6 }, () => detector.push(pcmFrame(300)));

    expect(speechResults.some((result) => result.speechStarted)).toBe(true);
  });

  it('requires neural speech evidence before confirming sustained high energy', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);
    const results = Array.from({ length: 10 }, () => detector.push(pcmFrame(8_000), { speechDetected: false }));

    expect(results.every((result) => !result.speechStarted && !result.segment)).toBe(true);
    expect(detector.hasPendingSpeech).toBe(false);
    expect(detector.flush()).toBeUndefined();
  });

  it('combines neural speech evidence with adaptive duration and level guards', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);
    const first = detector.push(pcmFrame(8_000), { speechDetected: true });
    const second = detector.push(pcmFrame(8_000), { speechDetected: true });

    expect(first.speechStarted).toBe(false);
    expect(second.speechStarted).toBe(true);
  });

  it('reports a collapsed provisional spike without confirming speech', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);

    const started = detector.push(pcmFrame(8_000));
    const ended = detector.push(pcmFrame(0));

    expect(started).toMatchObject({ provisionalSpeechStarted: true, provisionalSpeechEnded: false });
    expect(ended).toMatchObject({ provisionalSpeechStarted: false, provisionalSpeechEnded: true });
    expect(detector.flush()).toBeUndefined();
  });

  it('learns clean ambient sound but excludes playback overlap from calibration', () => {
    const detector = new AdaptiveVoiceActivityDetector({ ...TEST_CONFIGURATION, startupCalibrationMs: 40 });
    pushFrames(detector, [50, 50, 50, 50]);
    const learnedNoiseFloor = detector.noiseFloorDbfs;

    pushFrames(detector, [4_000, 4_000, 4_000], 20);

    expect(learnedNoiseFloor).toBeGreaterThan(-60);
    expect(detector.noiseFloorDbfs).toBe(learnedNoiseFloor);
  });

  it('reports provisional and active speech without exposing mutable VAD state', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);

    expect(detector.hasPendingSpeech).toBe(false);
    detector.push(pcmFrame(8_000));
    expect(detector.hasPendingSpeech).toBe(true);
    detector.push(pcmFrame(8_000));
    expect(detector.hasPendingSpeech).toBe(true);
    pushFrames(detector, [0, 0]);
    expect(detector.hasPendingSpeech).toBe(false);
  });

  it('preserves narration-handoff speech during incomplete startup calibration', () => {
    const detector = new AdaptiveVoiceActivityDetector({ ...TEST_CONFIGURATION, startupCalibrationMs: 100 });

    const first = detector.push(pcmFrame(8_000), { playbackOverlapMs: 20, narrationHandoff: true });
    const second = detector.push(pcmFrame(8_000), { playbackOverlapMs: 20, narrationHandoff: true });
    const segments = pushFrames(detector, [0, 0]);

    expect(first.speechStarted).toBe(false);
    expect(second.speechStarted).toBe(true);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.activityHistogram.buckets[0]?.playbackOverlapMs).toBe(40);
  });

  it('rejects a short noise spike and does not emit unconfirmed speech on flush', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);

    expect(pushFrames(detector, [0, 8_000, 0, 0])).toEqual([]);
    expect(detector.flush()).toBeUndefined();
  });

  it('includes pre-roll and chronological activity through trailing silence', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);

    const segments = pushFrames(detector, [100, 100, 8_000, 8_000, 0, 0]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      pcm: expect.any(Buffer),
      activityHistogram: {
        bucketMs: 40,
        durationMs: 120,
        voicedMs: 40,
        leadingSilenceMs: 40,
        trailingSilenceMs: 40,
        forcedClose: false,
      },
    });
    expect(segments[0]?.pcm).toHaveLength(PCM_FRAME_BYTES * 6);
    expect(segments[0]?.activityHistogram.buckets).toHaveLength(3);
    expect(segments[0]?.activityHistogram.buckets[1]?.levelDbAboveNoise).toBeGreaterThan(
      segments[0]?.activityHistogram.buckets[0]?.levelDbAboveNoise ?? 0,
    );
  });

  it('emits two distinct utterances in chronological order', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);

    const first = pushFrames(detector, [0, 0, 7_000, 7_000, 0, 0]);
    const second = pushFrames(detector, [0, 0, 9_000, 9_000, 0, 0]);

    expect([...first, ...second]).toHaveLength(2);
    expect(first[0]?.pcm.readInt16LE(PCM_FRAME_BYTES * 2)).toBe(7_000);
    expect(second[0]?.pcm.readInt16LE(PCM_FRAME_BYTES * 2)).toBe(9_000);
  });

  it('records playback overlap in bounded chronological buckets without learning it as ambience', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);
    const before = detector.noiseFloorDbfs;

    const segments = pushFrames(detector, [8_000, 8_000, 8_000, 8_000, 0, 0], 20);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.activityHistogram.buckets.map((bucket) => bucket.playbackOverlapMs)).toEqual([40, 40, 40]);
    expect(detector.noiseFloorDbfs).toBe(before);
  });

  it('force-closes bounded speech and flushes confirmed speech without synthetic padding', () => {
    const detector = new AdaptiveVoiceActivityDetector({
      ...TEST_CONFIGURATION,
      preRollMs: 20,
      minimumVoicedMs: 20,
      maximumSegmentMs: 80,
    });

    const forced = pushFrames(detector, [8_000, 8_000, 8_000, 8_000]);
    expect(forced).toHaveLength(1);
    expect(forced[0]?.activityHistogram).toMatchObject({ durationMs: 80, forcedClose: true });

    pushFrames(detector, [7_000, 7_000]);
    const flushed = detector.flush();
    expect(flushed?.pcm).toHaveLength(PCM_FRAME_BYTES * 2);
    expect(flushed?.activityHistogram).toMatchObject({ durationMs: 40, forcedClose: false });
  });

  it('retains startup calibration progress across a reset', () => {
    const detector = new AdaptiveVoiceActivityDetector({
      ...TEST_CONFIGURATION,
      startupCalibrationMs: 100,
    });

    pushFrames(detector, [80, 80, 80]);
    detector.reset();
    pushFrames(detector, [80, 80]);
    const speechResults = [detector.push(pcmFrame(4_000)), detector.push(pcmFrame(4_000))];

    expect(speechResults.some((result) => result.speechStarted)).toBe(true);
  });

  it('resets pending state while retaining the calibrated noise floor', () => {
    const detector = new AdaptiveVoiceActivityDetector(TEST_CONFIGURATION);
    pushFrames(detector, [200, 200, 8_000, 8_000]);
    const noiseFloor = detector.noiseFloorDbfs;

    detector.reset();

    expect(detector.flush()).toBeUndefined();
    expect(detector.noiseFloorDbfs).toBe(noiseFloor);
  });
});
