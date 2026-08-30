import {
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
} from '../src/types/manualTranscription.ts';

const DATA_TIMESLICE_MS = 1_000;
const MEDIA_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

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
  createRecorder: (stream: ManualMediaStream, options: { mimeType: string }) => ManualMediaRecorder;
  isTypeSupported: (type: string) => boolean;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
}

interface BrowserRecorderConstructor {
  new (stream: ManualMediaStream, options: { mimeType: string }): ManualMediaRecorder;
  isTypeSupported(type: string): boolean;
}

interface BrowserMediaGlobals {
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
  };
}

/** Owns one standalone browser recording. It has no connection to autonomous voice capture. */
export async function startManualBrowserRecording(
  dependencies: ManualRecorderDependencies = browserDependencies(),
): Promise<ManualBrowserRecording> {
  const mimeType = MEDIA_TYPES.find((type) => dependencies.isTypeSupported(type));
  if (mimeType === undefined) throw new Error('This browser cannot record WebM or MP4 audio.');

  const stream = await dependencies.getUserMedia();
  let recorder: ManualMediaRecorder;
  try {
    recorder = dependencies.createRecorder(stream, { mimeType });
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
  let resolveResult: (result: ManualBrowserRecordingResult | undefined) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<ManualBrowserRecordingResult | undefined>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const cleanup = (): void => {
    dependencies.clearTimer(timer);
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
