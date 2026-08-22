import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PCM_BYTES_PER_SAMPLE, PCM_FRAME_BYTES, PCM_SAMPLE_RATE } from '../../services/pcm.ts';
import type { ISpeechPresenceDetector } from '../../types/index.ts';

const SHERPA_ONNX_PACKAGE = 'sherpa-onnx-node';
const SILERO_MODEL_FILE = 'silero_vad_v6.2.1.onnx';
const SILERO_THRESHOLD = 0.5;
const SILERO_WINDOW_SAMPLES = 512;
const SILERO_WINDOW_BYTES = SILERO_WINDOW_SAMPLES * PCM_BYTES_PER_SAMPLE;
const SILERO_MINIMUM_SPEECH_SECONDS = 0.12;
const SILERO_MINIMUM_SILENCE_SECONDS = 0.1;
const SILERO_MAXIMUM_SPEECH_SECONDS = 30;
const SILERO_BUFFER_SECONDS = 60;
const PCM_VALUE_LIMIT = 32_768;

interface NativeVadConfig {
  sileroVad: {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    maxSpeechDuration: number;
    windowSize: number;
  };
  sampleRate: number;
  numThreads: number;
  provider: string;
  debug: boolean;
}

interface NativeVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
  reset(): void;
}

interface SherpaOnnxModule {
  Vad: new (configuration: NativeVadConfig, bufferSizeInSeconds: number) => NativeVad;
}

export interface SileroSpeechPresenceDetectorOptions {
  modelPath?: string;
  loadRuntime?: () => SherpaOnnxModule;
}

function loadSherpaOnnx(): SherpaOnnxModule {
  return createRequire(import.meta.url)(SHERPA_ONNX_PACKAGE) as SherpaOnnxModule;
}

export function findSileroVadModelPath(importFileUrl: string | URL): string {
  let directory = path.dirname(fileURLToPath(importFileUrl));
  while (true) {
    const candidate = path.join(directory, 'models', SILERO_MODEL_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Silero VAD model is missing: ${SILERO_MODEL_FILE}`);
}

export class SileroSpeechPresenceDetector implements ISpeechPresenceDetector {
  private readonly nativeVad: NativeVad;
  private readonly pcmWindow = Buffer.alloc(SILERO_WINDOW_BYTES);
  private readonly floatWindow = new Float32Array(SILERO_WINDOW_SAMPLES);
  private bufferedBytes = 0;
  private speechDetected = false;

  public constructor(options: SileroSpeechPresenceDetectorOptions = {}) {
    const model = options.modelPath ?? findSileroVadModelPath(import.meta.url);
    const runtime = (options.loadRuntime ?? loadSherpaOnnx)();
    this.nativeVad = new runtime.Vad(
      {
        sileroVad: {
          model,
          threshold: SILERO_THRESHOLD,
          minSpeechDuration: SILERO_MINIMUM_SPEECH_SECONDS,
          minSilenceDuration: SILERO_MINIMUM_SILENCE_SECONDS,
          maxSpeechDuration: SILERO_MAXIMUM_SPEECH_SECONDS,
          windowSize: SILERO_WINDOW_SAMPLES,
        },
        sampleRate: PCM_SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: false,
      },
      SILERO_BUFFER_SECONDS,
    );
  }

  public push(frame: Buffer): boolean {
    if (frame.length !== PCM_FRAME_BYTES) throw new Error(`Silero VAD requires ${PCM_FRAME_BYTES}-byte PCM frames`);
    let frameOffset = 0;
    while (frameOffset < frame.length) {
      const copiedBytes = Math.min(SILERO_WINDOW_BYTES - this.bufferedBytes, frame.length - frameOffset);
      frame.copy(this.pcmWindow, this.bufferedBytes, frameOffset, frameOffset + copiedBytes);
      this.bufferedBytes += copiedBytes;
      frameOffset += copiedBytes;
      if (this.bufferedBytes === SILERO_WINDOW_BYTES) this.processWindow();
    }
    return this.speechDetected;
  }

  public reset(): void {
    this.nativeVad.reset();
    this.bufferedBytes = 0;
    this.speechDetected = false;
  }

  private processWindow(): void {
    for (let sample = 0; sample < SILERO_WINDOW_SAMPLES; sample += 1)
      this.floatWindow[sample] = this.pcmWindow.readInt16LE(sample * PCM_BYTES_PER_SAMPLE) / PCM_VALUE_LIMIT;
    this.nativeVad.acceptWaveform(this.floatWindow);
    this.speechDetected = this.nativeVad.isDetected();
    while (!this.nativeVad.isEmpty()) this.nativeVad.pop();
    this.bufferedBytes = 0;
  }
}
