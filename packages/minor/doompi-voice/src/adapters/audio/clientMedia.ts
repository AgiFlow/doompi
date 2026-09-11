import { randomUUID } from 'node:crypto';
import { PcmFrameAssembler } from '../../services/pcm.ts';
import type {
  IClock,
  IPcmAudioRecorder,
  ITtsAdapter,
  IVoiceMediaHostConnection,
  LiveRecordingHandle,
  PcmAudioRecorderStartOptions,
  ProcessResult,
  TtsPlayback,
  TtsPlaybackReference,
  TtsPlaybackResult,
  TtsSpeakRequest,
} from '../../types/index.ts';
import type { VoiceMediaPlaybackDelivery, VoiceMediaPlaybackResult } from '../../types/clientMedia.ts';
import type { ResolvedVoiceConfig, VoiceTtsConfig } from '@agimon-ai/doompi-config';

const CAPTURE_ID_PREFIX = 'client-capture';
const PLAYBACK_ID_PREFIX = 'client-playback';
const PLAYBACK_AUDIO_CHUNK_BYTES = 64 * 1024;

export interface ClientNarrationSynthesizer {
  synthesize(request: TtsSpeakRequest, signal: AbortSignal): Promise<Buffer>;
}

/** Uses an injected browser/device media host without crossing an internal HTTP boundary. */
export function voiceMediaHostConnection(host?: IVoiceMediaHostConnection): IVoiceMediaHostConnection | undefined {
  return host;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedProcess(error: unknown): ProcessResult {
  return { code: 1, stdout: '', stderr: describeError(error) };
}

class ClientPcmRecording implements LiveRecordingHandle {
  public readonly completion: Promise<ProcessResult>;
  private readonly captureId = `${CAPTURE_ID_PREFIX}-${randomUUID()}`;
  private readonly assembler = new PcmFrameAssembler();
  private readonly started: Promise<void>;
  private aborting = false;
  private stopOperation: Promise<Buffer> | undefined;
  private abortOperation: Promise<Buffer> | undefined;

  public constructor(
    private readonly connection: IVoiceMediaHostConnection,
    onFrame: (frame: Buffer) => void,
    private readonly options: PcmAudioRecorderStartOptions,
  ) {
    this.started = connection.startCapture(this.captureId, options.capture);
    this.completion = this.consume(onFrame).catch(failedProcess);
  }

  public stop(): Promise<Buffer> {
    this.stopOperation ??= this.stopCapture();
    return this.stopOperation;
  }

  public abort(): Promise<Buffer> {
    this.abortOperation ??= this.abortCapture();
    return this.abortOperation;
  }

  private async consume(onFrame: (frame: Buffer) => void): Promise<ProcessResult> {
    await this.started;
    while (!this.aborting) {
      const batch = await this.connection.readCapture(this.captureId);
      if (batch.activity !== undefined) this.options.onClientActivity?.(batch.activity);
      for (const frame of this.assembler.push(batch.pcm)) onFrame(frame);
      if (batch.state === 'stopped') return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  private async stopCapture(): Promise<Buffer> {
    await this.started;
    await this.connection.stopCapture(this.captureId);
    const result = await this.completion;
    if (result.code !== 0) throw new Error(result.stderr || 'Voice media client stopped unexpectedly.');
    return this.assembler.flush();
  }

  private async abortCapture(): Promise<Buffer> {
    this.aborting = true;
    await this.started.then(
      () => this.connection.abortCapture(this.captureId),
      () => undefined,
    );
    await this.completion.catch(() => undefined);
    return this.assembler.flush();
  }
}

export class ClientPcmAudioRecorder implements IPcmAudioRecorder {
  public constructor(private readonly connection: IVoiceMediaHostConnection) {}

  public preflight(_config: ResolvedVoiceConfig): void {}

  public start(
    _config: ResolvedVoiceConfig,
    onFrame: (frame: Buffer) => void,
    options: PcmAudioRecorderStartOptions = {
      capture: { mode: 'manual', activityControl: 'host' },
    },
  ): LiveRecordingHandle {
    return new ClientPcmRecording(this.connection, onFrame, options);
  }
}

class ClientTtsPlayback implements TtsPlayback {
  public readonly reference: TtsPlaybackReference;
  public readonly completion: Promise<TtsPlaybackResult>;
  private readonly started: Promise<VoiceMediaPlaybackDelivery | void>;
  private readonly synthesisController = new AbortController();
  private stopOperation: Promise<void> | undefined;
  private abortOperation: Promise<void> | undefined;

  public constructor(
    private readonly request: TtsSpeakRequest,
    private readonly playbackId: string,
    private readonly connection: IVoiceMediaHostConnection,
    private readonly clock: IClock,
    private readonly synthesizer?: ClientNarrationSynthesizer,
  ) {
    this.reference = {
      id: request.id,
      kind: request.kind,
      text: request.text,
      startedAt: clock.now(),
    };
    this.started = connection.startPlayback({
      playbackId,
      text: request.text,
      ...(request.config.voice ? { voice: request.config.voice } : {}),
      ...(request.config.rate === undefined ? {} : { rate: request.config.rate }),
    });
    this.completion = this.settle();
  }

  public stop(): Promise<void> {
    this.stopOperation ??= this.stopPlayback(false);
    return this.stopOperation;
  }

  public abort(): Promise<void> {
    this.abortOperation ??= this.stopPlayback(true);
    return this.abortOperation;
  }

  private async settle(): Promise<TtsPlaybackResult> {
    try {
      const delivery = await this.started;
      if (delivery === 'streamed') await this.uploadNarration();
      let result: VoiceMediaPlaybackResult | undefined;
      while (result === undefined) result = await this.connection.readPlayback(this.playbackId);
      return {
        outcome: result.outcome,
        reference: { ...this.reference, endedAt: this.clock.now() },
        process: { code: result.outcome === 'failed' ? 1 : 0, stdout: '', stderr: result.error ?? '' },
      };
    } catch (error) {
      return {
        outcome: 'failed',
        reference: { ...this.reference, endedAt: this.clock.now() },
        process: failedProcess(error),
      };
    }
  }

  private async uploadNarration(): Promise<void> {
    if (
      this.synthesizer === undefined ||
      this.connection.sendPlaybackAudio === undefined ||
      this.connection.sealPlaybackAudio === undefined
    ) {
      await this.connection.sealPlaybackAudio?.(this.playbackId, 'Backend narration synthesis is unavailable.');
      return;
    }
    try {
      const pcm = await this.synthesizer.synthesize(this.request, this.synthesisController.signal);
      for (let offset = 0; offset < pcm.byteLength; offset += PLAYBACK_AUDIO_CHUNK_BYTES) {
        await this.connection.sendPlaybackAudio(
          this.playbackId,
          pcm.subarray(offset, offset + PLAYBACK_AUDIO_CHUNK_BYTES),
        );
      }
      await this.connection.sealPlaybackAudio(this.playbackId);
    } catch (error) {
      await this.connection.sealPlaybackAudio?.(this.playbackId, describeError(error)).catch(() => undefined);
    }
  }

  private async stopPlayback(abort: boolean): Promise<void> {
    this.synthesisController.abort();
    await this.started;
    if (abort) await this.connection.abortPlayback(this.playbackId);
    else await this.connection.stopPlayback(this.playbackId);
    await this.completion;
  }
}

export class ClientTtsAdapter implements ITtsAdapter {
  public constructor(
    private readonly connection: IVoiceMediaHostConnection,
    private readonly clock: IClock,
    private readonly synthesizer?: ClientNarrationSynthesizer,
  ) {}

  public preflight(_config: VoiceTtsConfig): void {}

  public speak(request: TtsSpeakRequest): TtsPlayback {
    const text = request.text.trim();
    if (!text) throw new Error('Voice narration text must not be empty');
    return new ClientTtsPlayback(
      { ...request, text },
      `${PLAYBACK_ID_PREFIX}-${String(request.id)}-${randomUUID()}`,
      this.connection,
      this.clock,
      this.synthesizer,
    );
  }
}
