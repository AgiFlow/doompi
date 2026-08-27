import type {
  VoiceMediaCapture,
  VoiceMediaClientEvent,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaTransport,
} from '../src/types/clientMedia.ts';

const RECONNECT_DELAY_MS = 2_000;

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
  private playback: VoiceMediaPlayback | undefined;
  private audioUploads: Promise<void> = Promise.resolve();
  private audioUploadError: Error | undefined;
  private connected = false;
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
    if (this.connected) await this.transport.disconnect(this.clientId, this.connectionId).catch(() => undefined);
    this.connected = false;
  }

  private async run(): Promise<void> {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      try {
        const connected = await this.transport.connect(this.clientId, this.connectionId, this.device.capabilities);
        this.connected = true;
        let cursor = connected.cursor;
        while (!signal.aborted) {
          const event = await this.transport.nextEvent(this.clientId, this.connectionId, cursor, signal);
          if (event === undefined) continue;
          cursor = event.sequence;
          await this.handle(event);
        }
      } catch {
        if (signal.aborted) return;
        await this.releaseMedia();
        if (this.connected) await this.transport.disconnect(this.clientId, this.connectionId).catch(() => undefined);
        this.connected = false;
        await delay(RECONNECT_DELAY_MS, signal);
      }
    }
  }

  private async handle(event: VoiceMediaClientEvent): Promise<void> {
    switch (event.type) {
      case 'capture-start':
        await this.startCapture(event.captureId);
        return;
      case 'capture-stop':
        if (this.captureId === event.captureId) await this.finishCapture(event.captureId, true);
        return;
      case 'capture-abort':
        if (this.captureId === event.captureId) await this.finishCapture(event.captureId, false);
        return;
      case 'playback-start':
        this.startPlayback(event);
        return;
      case 'playback-stop':
        this.playback?.stop('stopped');
        return;
      case 'playback-abort':
        this.playback?.stop('aborted');
        return;
    }
  }

  private async startCapture(captureId: string): Promise<void> {
    if (this.capture !== undefined) await this.finishCapture(this.captureId ?? captureId, false);
    this.captureId = captureId;
    this.audioUploads = Promise.resolve();
    this.audioUploadError = undefined;
    this.capture = await this.device.startCapture((pcm) => {
      const owned = new Uint8Array(pcm);
      this.audioUploads = this.audioUploads.then(async () => {
        if (this.audioUploadError !== undefined) return;
        try {
          await this.transport.sendAudio(this.clientId, this.connectionId, captureId, owned);
        } catch (error) {
          this.audioUploadError = error instanceof Error ? error : new Error(String(error));
        }
      });
    });
  }

  private async finishCapture(captureId: string, acknowledge: boolean): Promise<void> {
    await this.capture?.stop();
    this.capture = undefined;
    this.captureId = undefined;
    await this.audioUploads;
    if (this.audioUploadError !== undefined) throw this.audioUploadError;
    if (acknowledge) await this.transport.captureStopped(this.clientId, this.connectionId, captureId);
  }

  private startPlayback(event: Extract<VoiceMediaClientEvent, { type: 'playback-start' }>): void {
    this.playback?.stop('aborted');
    const playback = this.device.speak(event);
    this.playback = playback;
    void playback.completion
      .then((result) => this.transport.playbackFinished(this.clientId, this.connectionId, result))
      .catch(() => undefined)
      .finally(() => {
        if (this.playback === playback) this.playback = undefined;
      });
  }

  private async releaseMedia(): Promise<void> {
    await this.capture?.stop().catch(() => undefined);
    this.capture = undefined;
    this.captureId = undefined;
    this.playback?.stop('aborted');
    this.playback = undefined;
    await this.device.close().catch(() => undefined);
  }
}
