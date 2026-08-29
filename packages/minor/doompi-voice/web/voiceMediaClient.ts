import { ClientCaptureActivityLifecycle, type SpeechPresenceDetector } from '../src/types/clientCaptureActivity.ts';
import {
  type VoiceMediaCapture,
  type VoiceMediaClientEvent,
  type VoiceMediaDevice,
  type VoiceMediaPlayback,
  type VoiceMediaPlaybackResult,
  type VoiceMediaTransport,
} from '../src/types/clientMedia.ts';

const RECONNECT_DELAY_MS = 2_000;
const MAX_CONNECTION_ID_LENGTH = 200;

function playbackFailure(playbackId: string, error: unknown): VoiceMediaPlaybackResult {
  const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { playbackId, outcome: 'failed', error: failure };
}

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
  private playbackAudioController: AbortController | undefined;
  private audioUploads: Promise<void> = Promise.resolve();
  private audioUploadError: Error | undefined;
  private activeConnectionId: string | undefined;
  private connectionAttempt = 0;
  private failAttempt: ((error: Error) => void) | undefined;
  private runOperation: Promise<void> | undefined;
  private readonly listeningWaiters = new Set<(listening: boolean) => void>();

  public constructor(
    private readonly clientId: string,
    private readonly connectionId: string,
    private readonly transport: VoiceMediaTransport,
    private readonly device: VoiceMediaDevice,
  ) {}

  public start(): void {
    this.runOperation ??= this.run();
  }

  public get listening(): boolean {
    return this.capture !== undefined;
  }

  public waitForListening(): Promise<boolean> {
    if (this.listening) return Promise.resolve(true);
    if (this.abortController.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => this.listeningWaiters.add(resolve));
  }

  public async stop(closeDevice = true): Promise<void> {
    this.abortController.abort();
    await this.runOperation?.catch(() => undefined);
    await this.releaseMedia(closeDevice);
    const connectionId = this.activeConnectionId;
    if (connectionId !== undefined) await this.transport.disconnect(this.clientId, connectionId).catch(() => undefined);
    this.activeConnectionId = undefined;
    this.resolveListening(false);
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
        await this.startPlayback(event, connectionId);
        return;
      case 'playback-stop':
        this.playbackAudioController?.abort();
        this.playback?.stop('stopped');
        return;
      case 'playback-abort':
        this.playbackAudioController?.abort();
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
      this.resolveListening(true);
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
    this.resolveListening(false);
    if (acknowledge) await this.transport.captureStopped(this.clientId, connectionId, captureId);
  }

  private async startPlayback(
    event: Extract<VoiceMediaClientEvent, { type: 'playback-start' }>,
    connectionId: string,
  ): Promise<void> {
    this.playbackAudioController?.abort();
    this.playback?.stop('aborted');
    this.scheduleActivityReset();
    const audioController = event.delivery === 'streamed' ? new AbortController() : undefined;
    this.playbackAudioController = audioController;
    const audio = audioController
      ? this.transport.receivePlaybackAudio?.(this.clientId, connectionId, event.playbackId, audioController.signal)
      : undefined;
    let playback: VoiceMediaPlayback;
    try {
      playback = this.device.speak(event, audio);
    } catch (error) {
      audioController?.abort();
      await this.transport.playbackFinished(this.clientId, connectionId, playbackFailure(event.playbackId, error));
      this.scheduleActivityReset();
      return;
    }
    this.playback = playback;
    void playback.completion
      .then(
        (result) => this.transport.playbackFinished(this.clientId, connectionId, result),
        (error: unknown) =>
          this.transport.playbackFinished(this.clientId, connectionId, playbackFailure(event.playbackId, error)),
      )
      .catch(() => undefined)
      .finally(() => {
        if (this.playback !== playback) return;
        audioController?.abort();
        if (this.playbackAudioController === audioController) this.playbackAudioController = undefined;
        this.playback = undefined;
        this.scheduleActivityReset();
      });
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

  private async releaseMedia(closeDevice = true): Promise<void> {
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
    await capture?.stop().catch(() => undefined);
    this.resolveListening(false);
    void uploads.catch(() => undefined);
    void speechDetector?.reset().catch(() => undefined);
    this.playbackAudioController?.abort();
    this.playbackAudioController = undefined;
    this.playback?.stop('aborted');
    this.playback = undefined;
    if (closeDevice) await this.device.close().catch(() => undefined);
  }

  private resolveListening(listening: boolean): void {
    for (const resolve of this.listeningWaiters) resolve(listening);
    this.listeningWaiters.clear();
  }

  private nextConnectionId(): string {
    const suffix = `:${(++this.connectionAttempt).toString(36)}`;
    return `${this.connectionId.slice(0, MAX_CONNECTION_ID_LENGTH - suffix.length)}${suffix}`;
  }
}
