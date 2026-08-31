import {
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
} from '../src/types/manualTranscription.ts';

const DATA_TIMESLICE_MS = 1_000;
const SILENCE_SAMPLE_INTERVAL_MS = 100;
const INITIAL_SILENCE_TIMEOUT_MS = 10_000;
const TRAILING_SILENCE_TIMEOUT_MS = 3_000;
const SPEECH_RMS_THRESHOLD = 0.01;
const MEDIA_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

/** Tracks speech and reports when initial or trailing silence should finish a manual recording. */
export class ManualRecordingSilenceGate {
  private startedAt: number | undefined;
  private lastSpeechAt: number | undefined;

  public get speechDetected(): boolean {
    return this.lastSpeechAt !== undefined;
  }

  public observe(samples: Float32Array, observedAt: number): boolean {
    this.startedAt ??= observedAt;
    let squareSum = 0;
    for (const sample of samples) squareSum += sample * sample;
    const rms = samples.length === 0 ? 0 : Math.sqrt(squareSum / samples.length);
    if (rms >= SPEECH_RMS_THRESHOLD) {
      this.lastSpeechAt = observedAt;
      return false;
    }
    const silenceStartedAt = this.lastSpeechAt ?? this.startedAt;
    const timeout = this.speechDetected ? TRAILING_SILENCE_TIMEOUT_MS : INITIAL_SILENCE_TIMEOUT_MS;
    return observedAt - silenceStartedAt >= timeout;
  }
}

type RecorderState = 'inactive' | 'recording' | 'paused';

interface ManualMediaStream {
  getTracks(): Array<{ stop(): void }>;
}

interface ManualMediaRecorder {
  readonly mimeType: string;
  state: RecorderState;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((event: { error?: Error }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

interface ManualRecorderDependencies {
  getUserMedia: () => Promise<ManualMediaStream>;
  createRecorder: (stream: ManualMediaStream, options?: { mimeType: string }) => ManualMediaRecorder;
  isTypeSupported: (type: string) => boolean;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  watchSilence?: (stream: ManualMediaStream, onSilence: (speechDetected: boolean) => void) => () => void;
}

interface ManualAudioAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  getFloatTimeDomainData(samples: Float32Array): void;
}

interface ManualAudioSource {
  connect(analyser: ManualAudioAnalyser): void;
  disconnect(): void;
}

interface ManualAudioContext {
  createMediaStreamSource(stream: ManualMediaStream): ManualAudioSource;
  createAnalyser(): ManualAudioAnalyser;
  resume(): Promise<void>;
  close(): Promise<void>;
}

interface BrowserRecorderConstructor {
  new (stream: ManualMediaStream, options?: { mimeType: string }): ManualMediaRecorder;
  isTypeSupported(type: string): boolean;
}

interface BrowserAudioContextConstructor {
  new (): ManualAudioContext;
}

interface BrowserMediaGlobals {
  AudioContext?: BrowserAudioContextConstructor;
  MediaRecorder?: BrowserRecorderConstructor;
  navigator?: { mediaDevices?: { getUserMedia(options: { audio: boolean }): Promise<ManualMediaStream> } };
}

export interface ManualBrowserRecordingResult {
  readonly audio: Blob;
  readonly durationMs: number;
}

export interface ManualBrowserRecording {
  readonly result: Promise<ManualBrowserRecordingResult | undefined>;
  stop(): void;
  cancel(): void;
}

function watchBrowserSilence(stream: ManualMediaStream, onSilence: (speechDetected: boolean) => void): () => void {
  const AudioContextConstructor = (globalThis as unknown as BrowserMediaGlobals).AudioContext;
  if (AudioContextConstructor === undefined) return () => undefined;
  let context: ManualAudioContext | undefined;
  let source: ManualAudioSource | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    context = new AudioContextConstructor();
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2_048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const gate = new ManualRecordingSilenceGate();
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      if (!gate.observe(samples, Date.now())) return;
      onSilence(gate.speechDetected);
    }, SILENCE_SAMPLE_INTERVAL_MS);
    void context.resume().catch(() => undefined);
  } catch {
    source?.disconnect();
    void context?.close().catch(() => undefined);
    return () => undefined;
  }
  return () => {
    if (timer !== undefined) clearInterval(timer);
    source?.disconnect();
    void context?.close().catch(() => undefined);
  };
}

function browserDependencies(): ManualRecorderDependencies {
  const browser = globalThis as unknown as BrowserMediaGlobals;
  const Recorder = browser.MediaRecorder;
  const mediaDevices = browser.navigator?.mediaDevices;
  if (Recorder === undefined || mediaDevices === undefined) {
    throw new Error('This browser cannot record microphone audio.');
  }
  return {
    getUserMedia: async () => await mediaDevices.getUserMedia({ audio: true }),
    createRecorder: (stream, options) => new Recorder(stream, options),
    isTypeSupported: (type) => Recorder.isTypeSupported(type),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    watchSilence: watchBrowserSilence,
  };
}

/** Owns one standalone browser recording. It has no connection to autonomous voice capture. */
export async function startManualBrowserRecording(
  dependencies: ManualRecorderDependencies = browserDependencies(),
): Promise<ManualBrowserRecording> {
  const mimeType = MEDIA_TYPES.find((type) => dependencies.isTypeSupported(type));
  const stream = await dependencies.getUserMedia();
  let recorder: ManualMediaRecorder;
  try {
    recorder = dependencies.createRecorder(stream, mimeType === undefined ? undefined : { mimeType });
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }

  const chunks: Blob[] = [];
  let byteLength = 0;
  let sizeError: Error | undefined;
  let finished = false;
  let cancelled = false;
  let stopping = false;
  let startedAt = 0;
  let stopSilenceMonitor = (): void => undefined;
  let resolveResult: (result: ManualBrowserRecordingResult | undefined) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<ManualBrowserRecordingResult | undefined>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const cleanup = (): void => {
    dependencies.clearTimer(timer);
    stopSilenceMonitor();
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    for (const track of stream.getTracks()) track.stop();
  };
  const settle = (audio?: Blob, error?: Error): void => {
    if (finished) return;
    finished = true;
    cleanup();
    if (error !== undefined) rejectResult(error);
    else if (cancelled || audio === undefined) resolveResult(undefined);
    else
      resolveResult({
        audio,
        durationMs: Math.min(
          MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
          Math.max(0, Math.round(dependencies.now() - startedAt)),
        ),
      });
  };
  const audioBlob = (): Blob => {
    const actualMimeType = recorder.mimeType || chunks.find((chunk) => chunk.type.length > 0)?.type || '';
    return new Blob(chunks, { type: actualMimeType });
  };
  const stopRecorder = (): void => {
    if (finished || stopping) return;
    if (recorder.state === 'inactive') {
      settle(cancelled || sizeError !== undefined ? undefined : audioBlob(), sizeError);
      return;
    }
    stopping = true;
    try {
      recorder.stop();
    } catch (error) {
      settle(undefined, error instanceof Error ? error : new Error('Browser audio recording failed.'));
    }
  };
  const timer = dependencies.setTimer(stopRecorder, MANUAL_TRANSCRIPTION_MAX_DURATION_MS);

  recorder.ondataavailable = (event) => {
    if (finished || cancelled || sizeError !== undefined || event.data.size === 0) return;
    const nextByteLength = byteLength + event.data.size;
    if (nextByteLength > MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      sizeError = new Error('The recording exceeds the 4 MiB transcription limit.');
      stopRecorder();
      return;
    }
    byteLength = nextByteLength;
    chunks.push(event.data);
  };
  recorder.onerror = (event) =>
    settle(undefined, sizeError ?? event.error ?? new Error('Browser audio recording failed.'));
  recorder.onstop = () => settle(sizeError === undefined ? audioBlob() : undefined, sizeError);

  try {
    startedAt = dependencies.now();
    recorder.start(DATA_TIMESLICE_MS);
    const stopWatching = dependencies.watchSilence?.(stream, (speechDetected) => {
      if (!speechDetected) cancelled = true;
      stopRecorder();
    });
    if (stopWatching !== undefined) {
      stopSilenceMonitor = stopWatching;
      if (finished) stopSilenceMonitor();
    }
  } catch (error) {
    settle(undefined, error instanceof Error ? error : new Error('Browser audio recording failed.'));
    await result;
  }

  return {
    result,
    stop: stopRecorder,
    cancel: () => {
      cancelled = true;
      stopRecorder();
    },
  };
}
