import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { findSileroVadModelPath, SileroSpeechPresenceDetector } from '../src/adapters/audio/silero.ts';
import { PCM_FRAME_BYTES, PCM_FRAME_MS, PCM_SAMPLE_RATE } from '../src/services/pcm.ts';
import { AdaptiveVoiceActivityDetector } from '../src/services/vad.ts';

const SILERO_MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
const FIXTURE_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TWO_PI = Math.PI * 2;

class FakeNativeVad {
  public readonly accepted: Float32Array[] = [];
  public readonly configuration: unknown;
  public readonly bufferSizeInSeconds: number;
  public popCount = 0;
  public resetCount = 0;
  private detected = false;
  private queued = false;

  public constructor(configuration: unknown, bufferSizeInSeconds: number) {
    this.configuration = configuration;
    this.bufferSizeInSeconds = bufferSizeInSeconds;
  }

  public acceptWaveform(samples: Float32Array): void {
    this.accepted.push(Float32Array.from(samples));
    this.detected = true;
    this.queued = true;
  }

  public isDetected(): boolean {
    return this.detected;
  }

  public isEmpty(): boolean {
    return !this.queued;
  }

  public pop(): void {
    this.popCount += 1;
    this.queued = false;
  }

  public reset(): void {
    this.resetCount += 1;
    this.detected = false;
    this.queued = false;
  }
}

function constantFrame(sample: number): Buffer {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(sample, offset);
  return frame;
}

function readWavPcm(filePath: string): Buffer {
  const wav = fs.readFileSync(filePath);
  const dataTagOffset = wav.indexOf(Buffer.from('data'));
  if (dataTagOffset < 0) throw new Error('WAV fixture is missing its data chunk');
  const dataBytes = wav.readUInt32LE(dataTagOffset + 4);
  return wav.subarray(dataTagOffset + 8, dataTagOffset + 8 + dataBytes);
}

function scalePcm(pcm: Buffer, factor: number): Buffer {
  const scaled = Buffer.alloc(pcm.length);
  for (let offset = 0; offset < pcm.length; offset += 2)
    scaled.writeInt16LE(Math.round(pcm.readInt16LE(offset) * factor), offset);
  return scaled;
}

function generatedPcm(seconds: number, sampleAt: (sample: number) => number): Buffer {
  const sampleCount = seconds * PCM_SAMPLE_RATE;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.max(-32_768, Math.min(32_767, Math.round(sampleAt(sample))));
    pcm.writeInt16LE(value, sample * 2);
  }
  return pcm;
}

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000 - 0.5;
  };
}

function nonSpeechFixtures(): ReadonlyArray<{ name: string; pcm: Buffer }> {
  const fanNoise = seededNoise(1);
  const whiteNoise = seededNoise(2);
  return [
    {
      name: 'fan',
      pcm: generatedPcm(
        3,
        (sample) =>
          420 * Math.sin((TWO_PI * 93 * sample) / PCM_SAMPLE_RATE) +
          180 * Math.sin((TWO_PI * 186 * sample) / PCM_SAMPLE_RATE) +
          fanNoise() * 180,
      ),
    },
    {
      name: 'typing',
      pcm: generatedPcm(3, (sample) => {
        const phase = sample % 3_200;
        return phase < 160 ? 12_000 * Math.exp(-phase / 28) * (phase % 2 === 0 ? 1 : -1) : 0;
      }),
    },
    {
      name: 'impact',
      pcm: generatedPcm(3, (sample) => {
        const phase = sample - PCM_SAMPLE_RATE;
        return phase >= 0 && phase < 1_600
          ? 14_000 * Math.exp(-phase / 160) * Math.sin((TWO_PI * 730 * phase) / PCM_SAMPLE_RATE)
          : 0;
      }),
    },
    {
      name: 'music',
      pcm: generatedPcm(3, (sample) => {
        const note = [261.63, 329.63, 392][Math.floor(sample / 6_400) % 3]!;
        return (
          1_600 * Math.sin((TWO_PI * note * sample) / PCM_SAMPLE_RATE) +
          800 * Math.sin((TWO_PI * note * 2 * sample) / PCM_SAMPLE_RATE)
        );
      }),
    },
    {
      name: 'white noise',
      pcm: generatedPcm(3, () => whiteNoise() * 2_400),
    },
  ];
}

function detectedMilliseconds(detector: SileroSpeechPresenceDetector, pcm: Buffer): number {
  let detectedFrames = 0;
  for (let offset = 0; offset + PCM_FRAME_BYTES <= pcm.length; offset += PCM_FRAME_BYTES)
    if (detector.push(pcm.subarray(offset, offset + PCM_FRAME_BYTES))) detectedFrames += 1;
  return detectedFrames * PCM_FRAME_MS;
}

function hybridSpeechStarts(pcm: Buffer): boolean {
  const speechDetector = new SileroSpeechPresenceDetector();
  const adaptiveDetector = new AdaptiveVoiceActivityDetector();
  for (let offset = 0; offset + PCM_FRAME_BYTES <= pcm.length; offset += PCM_FRAME_BYTES) {
    const frame = pcm.subarray(offset, offset + PCM_FRAME_BYTES);
    const result = adaptiveDetector.push(frame, { speechDetected: speechDetector.push(frame) });
    if (result.speechStarted) return true;
  }
  return false;
}

describe('Silero speech presence detector', () => {
  it('packages the pinned upstream model with its verified digest', () => {
    const modelPath = findSileroVadModelPath(import.meta.url);

    expect(path.basename(modelPath)).toBe('silero_vad_v6.2.1.onnx');
    expect(createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex')).toBe(SILERO_MODEL_SHA256);
  });

  it('buffers 20 ms PCM frames into normalized 512-sample windows and drains native segments', () => {
    let nativeVad: FakeNativeVad | undefined;
    const captureNativeVad = (instance: FakeNativeVad): void => {
      nativeVad = instance;
    };
    const detector = new SileroSpeechPresenceDetector({
      modelPath: '/virtual/silero.onnx',
      loadRuntime: () => ({
        Vad: class extends FakeNativeVad {
          public constructor(configuration: unknown, bufferSizeInSeconds: number) {
            super(configuration, bufferSizeInSeconds);
            captureNativeVad(this);
          }
        },
      }),
    });

    expect(detector.push(constantFrame(-32_768))).toBe(false);
    expect(detector.push(constantFrame(16_384))).toBe(true);
    expect(nativeVad?.accepted).toHaveLength(1);
    expect(nativeVad?.accepted[0]?.[0]).toBe(-1);
    expect(nativeVad?.accepted[0]?.[319]).toBe(-1);
    expect(nativeVad?.accepted[0]?.[320]).toBe(0.5);
    expect(nativeVad?.accepted[0]?.[511]).toBe(0.5);
    expect(nativeVad).toMatchObject({
      bufferSizeInSeconds: 60,
      popCount: 1,
      configuration: {
        sampleRate: 16_000,
        numThreads: 1,
        provider: 'cpu',
        sileroVad: {
          model: '/virtual/silero.onnx',
          threshold: 0.5,
          minSpeechDuration: 0.12,
          minSilenceDuration: 0.1,
          maxSpeechDuration: 30,
          windowSize: 512,
        },
      },
    });

    detector.reset();
    expect(detector.push(constantFrame(16_384))).toBe(false);
    expect(nativeVad?.accepted).toHaveLength(1);
    expect(nativeVad?.resetCount).toBe(1);
  });

  it('rejects malformed capture frames before native inference', () => {
    const detector = new SileroSpeechPresenceDetector({
      modelPath: '/virtual/silero.onnx',
      loadRuntime: () => ({ Vad: FakeNativeVad }),
    });

    expect(() => detector.push(Buffer.alloc(PCM_FRAME_BYTES - 2))).toThrow(
      `Silero VAD requires ${PCM_FRAME_BYTES}-byte PCM frames`,
    );
  });

  it('detects an attenuated upstream speech recording through the hybrid guard', () => {
    const detector = new SileroSpeechPresenceDetector();
    const speech = scalePcm(readWavPcm(path.join(FIXTURE_DIRECTORY, 'silero-speech.wav')), 0.03);

    expect(detectedMilliseconds(detector, speech)).toBeGreaterThanOrEqual(1_500);
    expect(hybridSpeechStarts(speech)).toBe(true);
  });

  it.each(nonSpeechFixtures())('rejects synthetic $name audio', ({ pcm }) => {
    const detector = new SileroSpeechPresenceDetector();

    expect(detectedMilliseconds(detector, pcm)).toBe(0);
  });
});
