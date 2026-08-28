import {
  VOICE_MEDIA_BITS_PER_SAMPLE,
  VOICE_MEDIA_CHANNELS,
  VOICE_MEDIA_SAMPLE_RATE,
  type VoiceMediaCaptureActivity,
} from './clientMedia.ts';

const DEFAULT_ENDPOINT_SILENCE_MS = 600;
const MINIMUM_SPEECH_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * 120) / 1_000;
const SILENCE_DBFS = -120;
const PCM_VALUE_LIMIT = 32_768;
const PCM_BYTES_PER_SAMPLE = VOICE_MEDIA_BITS_PER_SAMPLE / 8;
const PCM_BYTES_PER_SECOND = VOICE_MEDIA_SAMPLE_RATE * VOICE_MEDIA_CHANNELS * PCM_BYTES_PER_SAMPLE;

export interface SpeechPresenceWindow {
  readonly speech: boolean;
  readonly sampleCount: number;
}

/** Platform boundary for browser workers and native speech-presence implementations. */
export interface SpeechPresenceDetector {
  push(pcm: Uint8Array): Promise<readonly SpeechPresenceWindow[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Calculates the RMS level of complete little-endian PCM16 samples without environment-specific APIs. */
export function calculateClientPcmDbfs(pcm: Uint8Array): number {
  if (pcm.byteLength === 0 || pcm.byteLength % PCM_BYTES_PER_SAMPLE !== 0)
    throw new Error('PCM activity input must contain complete 16-bit samples.');
  let squareSum = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += PCM_BYTES_PER_SAMPLE) {
    const unsigned = pcm[offset]! | (pcm[offset + 1]! << 8);
    const sample = (unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned) / PCM_VALUE_LIMIT;
    squareSum += sample * sample;
  }
  const rms = Math.sqrt(squareSum / (pcm.byteLength / PCM_BYTES_PER_SAMPLE));
  return rms === 0 ? SILENCE_DBFS : 20 * Math.log10(rms);
}

/** Portable lifecycle. Classifier windows are authoritative; RMS is level telemetry only. */
export class ClientCaptureActivityLifecycle {
  private elapsedBytes = 0;
  private activityEpoch = 0;
  private consecutiveSpeechSamples = 0;
  private classifiedSpeechSamples = 0;
  private trailingSilenceSamples = 0;
  private speechStarted = false;
  private endpointReached = false;

  public constructor(private readonly endpointSilenceMs = DEFAULT_ENDPOINT_SILENCE_MS) {
    if (!Number.isSafeInteger(endpointSilenceMs) || endpointSilenceMs < 250)
      throw new Error('Client endpoint silence must be an integer of at least 250 ms.');
  }

  public push(pcm: Uint8Array, windows: readonly SpeechPresenceWindow[] = []): VoiceMediaCaptureActivity {
    const levelDbfs = calculateClientPcmDbfs(pcm);
    this.elapsedBytes += pcm.byteLength;

    for (const window of windows) {
      if (!Number.isSafeInteger(window.sampleCount) || window.sampleCount <= 0)
        throw new Error('Speech-presence windows must contain a positive integer sample count.');
      if (this.endpointReached) continue;
      if (window.speech) {
        this.classifiedSpeechSamples += window.sampleCount;
        if (this.speechStarted) {
          this.trailingSilenceSamples = 0;
        } else {
          this.consecutiveSpeechSamples += window.sampleCount;
          if (this.consecutiveSpeechSamples >= MINIMUM_SPEECH_SAMPLES) {
            this.speechStarted = true;
            this.consecutiveSpeechSamples = 0;
            this.trailingSilenceSamples = 0;
          }
        }
      } else {
        this.consecutiveSpeechSamples = 0;
        if (this.speechStarted) this.trailingSilenceSamples += window.sampleCount;
      }
      const trailingSilenceMs = (this.trailingSilenceSamples / VOICE_MEDIA_SAMPLE_RATE) * 1_000;
      if (this.speechStarted && trailingSilenceMs >= this.endpointSilenceMs) this.endpointReached = true;
    }

    return {
      state: this.endpointReached ? 'endpoint' : this.speechStarted ? 'speech' : 'listening',
      levelDbfs: round(clamp(levelDbfs, SILENCE_DBFS, 0)),
      elapsedMs: Math.round((this.elapsedBytes / PCM_BYTES_PER_SECOND) * 1_000),
      epoch: this.activityEpoch,
      classifiedSpeechMs: Math.round((this.classifiedSpeechSamples / VOICE_MEDIA_SAMPLE_RATE) * 1_000),
    };
  }

  /** Starts a fresh classifier phase while preserving monotonic capture time. */
  public resetActivity(): void {
    this.activityEpoch += 1;
    this.consecutiveSpeechSamples = 0;
    this.classifiedSpeechSamples = 0;
    this.trailingSilenceSamples = 0;
    this.speechStarted = false;
    this.endpointReached = false;
  }
}
