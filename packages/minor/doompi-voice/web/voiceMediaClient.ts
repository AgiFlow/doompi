import {
  ClientCaptureActivityLifecycle,
  type SpeechPresenceDetector,
  type SpeechPresenceWindow,
} from '../src/types/clientCaptureActivity.ts';
import {
  VOICE_MEDIA_SAMPLE_RATE,
  type VoiceMediaCapture,
  type VoiceMediaClientEvent,
  type VoiceMediaDevice,
  type VoiceMediaPlayback,
  type VoiceMediaTransport,
} from '../src/types/clientMedia.ts';

const RECONNECT_DELAY_MS = 2_000;
const MAX_CONNECTION_ID_LENGTH = 200;
const DUCK_CUE_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * 64) / 1_000;
const DUCK_TARGET_GAIN = 0.2;
const DUCK_FADE_MS = 300;
const DUCK_HOLD_MS = 5_000;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class VoiceMediaClient {
  private readonly abortController = new AbortController();
  private capture: VoiceMediaCapture | undefined;
  private captureId: string | undefined;
  private captureGeneration = 0;
  private speechDetector: SpeechPresenceDetector | undefined;
  private activityLifecycle: ClientCaptureActivityLifecycle | undefined;
  private playback: VoiceMediaPlayback | undefined;
  private duckedPlayback: VoiceMediaPlayback | undefined;
  private duckCueSamples = 0;
  private audioUploads: Promise<void> = Promise.resolve();
  private audioUploadError: Error | undefined;
  private activeConnectionId: string | undefined;
  private connectionAttempt = 0;
  private failAttempt: ((error: Error) => void) | undefined;
  private runOperation: Promise<void> | undefined;

  public constructor(
    private readonly clientId: string,
    private readonly connectionId: string,
    private readonly transport: VoiceMediaTransport,
    private readonly device: VoiceMediaDevice,
  ) {}

  public start(): void {
    this.runOperation ??= this.run();
  }

  public async stop(): Promise<void> {
    this.abortController.abort();
    await this.runOperation?.catch(() => undefined);
    await this.releaseMedia();
    const connectionId = this.activeConnectionId;
    if (connectionId !== undefined) await this.transport.disconnect(this.clientId, connectionId).catch(() => undefined);
    this.activeConnectionId = undefined;
  }

  private async run(): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      const connectionId = this.nextConnectionId();
      const attemptController = new AbortController();
      const abortAttempt = (): void => attemptController.abort();
      signal.addEventListener('abort', abortAttempt, { once: true });
      let rejectAttempt!: (error: Error) => void;
      const attemptFailed = new Promise<never>((_resolve, reject) => {
        rejectAttempt = reject;
      });
      this.failAttempt = rejectAttempt;
      try {
        await this.device.prepare?.();
        const connected = await this.transport.connect(this.clientId, connectionId, this.device.capabilities);
        this.activeConnectionId = connectionId;
        let cursor = connected.cursor;
        while (!signal.aborted) {
          const event = await Promise.race([
            this.transport.nextEvent(this.clientId, connectionId, cursor, attemptController.signal),
            attemptFailed,
          ]);
          if (event === undefined) continue;
          cursor = event.sequence;
          await this.handle(event, connectionId);
        }
      } catch {
        if (signal.aborted) return;
        attemptController.abort();
        await this.releaseMedia();
        if (this.activeConnectionId === connectionId) {
          await this.transport.disconnect(this.clientId, connectionId).catch(() => undefined);
          this.activeConnectionId = undefined;
        }
        await delay(RECONNECT_DELAY_MS, signal);
      } finally {
        signal.removeEventListener('abort', abortAttempt);
        if (this.failAttempt === rejectAttempt) this.failAttempt = undefined;
      }
    }
  }

  private async handle(event: VoiceMediaClientEvent, connectionId: string): Promise<void> {
    switch (event.type) {
      case 'capture-start':
        await this.startCapture(event, connectionId);
        return;
      case 'capture-stop':
        if (this.captureId === event.captureId) await this.finishCapture(event.captureId, connectionId, true);
        return;
      case 'capture-abort':
        if (this.captureId === event.captureId) await this.finishCapture(event.captureId, connectionId, false);
        return;
      case 'playback-start':
        this.startPlayback(event, connectionId);
        return;
      case 'playback-stop':
        this.playback?.stop('stopped');
        return;
      case 'playback-abort':
        this.playback?.stop('aborted');
        return;
    }
  }

  private async startCapture(
    event: Extract<VoiceMediaClientEvent, { type: 'capture-start' }>,
    connectionId: string,
  ): Promise<void> {
    const { captureId, configuration } = event;
    if (this.capture !== undefined) await this.finishCapture(this.captureId ?? captureId, connectionId, false);
    const generation = ++this.captureGeneration;
    this.captureId = captureId;
    this.audioUploads = Promise.resolve();
    this.audioUploadError = undefined;
    const speechDetector =
      configuration.activityControl === 'client' ? this.device.createSpeechPresenceDetector?.() : undefined;
    const activityLifecycle =
      configuration.activityControl === 'client' && speechDetector !== undefined
        ? new ClientCaptureActivityLifecycle(configuration.endpointSilenceMs)
        : undefined;
    this.speechDetector = speechDetector;
    this.activityLifecycle = activityLifecycle;
    try {
      this.capture = await this.device.startCapture((pcm) => {
        if (generation !== this.captureGeneration || this.captureId !== captureId) return;
        const owned = new Uint8Array(pcm);
        this.audioUploads = this.audioUploads.then(async () => {
          if (
            this.audioUploadError !== undefined ||
            generation !== this.captureGeneration ||
            this.captureId !== captureId
          )
            return;
          try {
            const windows = await speechDetector?.push(owned);
            if (generation !== this.captureGeneration || this.captureId !== captureId) return;
            this.observePlaybackCue(windows ?? []);
            const activity = activityLifecycle?.push(owned, windows);
            await this.transport.sendAudio(this.clientId, connectionId, captureId, owned, activity);
          } catch (error) {
            if (generation !== this.captureGeneration || this.captureId !== captureId) return;
            const failure = error instanceof Error ? error : new Error(String(error));
            this.audioUploadError = failure;
            await this.failActiveCapture(captureId, connectionId, generation, failure);
          }
        });
      });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      await this.transport.captureStopped(this.clientId, connectionId, captureId, message).catch(() => undefined);
      this.captureId = undefined;
      this.captureGeneration += 1;
      throw error;
    }
  }

  private async failActiveCapture(
    captureId: string,
    connectionId: string,
    generation: number,
    error: Error,
  ): Promise<void> {
    if (generation !== this.captureGeneration || this.captureId !== captureId) return;
    const capture = this.capture;
    this.capture = undefined;
    await capture?.stop().catch(() => undefined);
    if (generation !== this.captureGeneration || this.captureId !== captureId) return;
    this.captureId = undefined;
    this.captureGeneration += 1;
    void this.transport
      .captureStopped(this.clientId, connectionId, captureId, `${error.name}: ${error.message}`)
      .catch(() => undefined);
    this.failAttempt?.(error);
  }

  private async finishCapture(captureId: string, connectionId: string, acknowledge: boolean): Promise<void> {
    await this.capture?.stop();
    this.capture = undefined;
    await this.audioUploads;
    await this.speechDetector?.reset().catch(() => undefined);
    this.speechDetector = undefined;
    this.activityLifecycle = undefined;
    this.duckCueSamples = 0;
    this.duckedPlayback = undefined;
    if (this.audioUploadError !== undefined) {
      const error = this.audioUploadError;
      await this.transport
        .captureStopped(this.clientId, connectionId, captureId, `${error.name}: ${error.message}`)
        .catch(() => undefined);
      this.captureId = undefined;
      this.captureGeneration += 1;
      throw error;
    }
    this.captureId = undefined;
    this.captureGeneration += 1;
    if (acknowledge) await this.transport.captureStopped(this.clientId, connectionId, captureId);
  }

  private startPlayback(event: Extract<VoiceMediaClientEvent, { type: 'playback-start' }>, connectionId: string): void {
    this.playback?.stop('aborted');
    this.scheduleActivityReset();
    const playback = this.device.speak(event);
    this.playback = playback;
    this.duckedPlayback = undefined;
    this.duckCueSamples = 0;
    void playback.completion
      .then((result) => this.transport.playbackFinished(this.clientId, connectionId, result))
      .catch(() => undefined)
      .finally(() => {
        if (this.playback !== playback) return;
        this.playback = undefined;
        if (this.duckedPlayback === playback) this.duckedPlayback = undefined;
        this.duckCueSamples = 0;
        this.scheduleActivityReset();
      });
  }

  private observePlaybackCue(windows: readonly SpeechPresenceWindow[]): void {
    const playback = this.playback;
    if (!playback || playback.duck === undefined) {
      this.duckCueSamples = 0;
      return;
    }
    if (this.duckedPlayback === playback) return;
    for (const window of windows) {
      this.duckCueSamples = window.speech ? this.duckCueSamples + window.sampleCount : 0;
      if (this.duckCueSamples < DUCK_CUE_SAMPLES) continue;
      this.duckedPlayback = playback;
      playback.duck(DUCK_TARGET_GAIN, DUCK_FADE_MS, DUCK_HOLD_MS);
      return;
    }
  }

  private scheduleActivityReset(): void {
    const generation = this.captureGeneration;
    const lifecycle = this.activityLifecycle;
    const detector = this.speechDetector;
    if (!lifecycle || !detector) return;
    this.audioUploads = this.audioUploads.then(async () => {
      if (
        generation !== this.captureGeneration ||
        lifecycle !== this.activityLifecycle ||
        detector !== this.speechDetector
      )
        return;
      lifecycle.resetActivity();
      await detector.reset().catch(() => undefined);
    });
  }

  private async releaseMedia(): Promise<void> {
    this.captureGeneration += 1;
    const capture = this.capture;
    const uploads = this.audioUploads;
    const speechDetector = this.speechDetector;
    this.capture = undefined;
    this.audioUploads = Promise.resolve();
    this.speechDetector = undefined;
    this.activityLifecycle = undefined;
    this.captureId = undefined;
    this.audioUploadError = undefined;
    this.duckedPlayback = undefined;
    this.duckCueSamples = 0;
    await capture?.stop().catch(() => undefined);
    void uploads.catch(() => undefined);
    void speechDetector?.reset().catch(() => undefined);
    this.playback?.stop('aborted');
    this.playback = undefined;
    await this.device.close().catch(() => undefined);
  }

  private nextConnectionId(): string {
    const suffix = `:${(++this.connectionAttempt).toString(36)}`;
    return `${this.connectionId.slice(0, MAX_CONNECTION_ID_LENGTH - suffix.length)}${suffix}`;
  }
}
