import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  DOOM_API_INTERNAL_TOKEN_ENV,
  DOOM_API_ROUTE_PREFIX,
  DOOM_API_SOCKET_ENV,
} from '@agimon-ai/doompi-extension-contracts/package-api';
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
  VoiceMediaAudioPoll,
} from '../../types/index.ts';
import {
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_EPOCH_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  VOICE_MEDIA_API_BASE_PATH,
  type VoiceMediaCaptureActivity,
  type VoiceMediaCaptureConfiguration,
  VOICE_MEDIA_CONTENT_TYPE,
  type VoiceMediaPlaybackDelivery,
  type VoiceMediaPlaybackResult,
  VOICE_MEDIA_ROUTES,
} from '../../types/clientMedia.ts';
import type { ResolvedVoiceConfig, VoiceTtsConfig } from '@agimon-ai/doompi-config';

const JSON_CONTENT_TYPE = 'application/json';
const CAPTURE_ID_PREFIX = 'client-capture';
const PLAYBACK_ID_PREFIX = 'client-playback';
const PLAYBACK_AUDIO_CHUNK_BYTES = 64 * 1024;

export interface ClientNarrationSynthesizer {
  synthesize(request: TtsSpeakRequest, signal: AbortSignal): Promise<Buffer>;
}

interface UnixResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedProcess(error: unknown): ProcessResult {
  return { code: 1, stdout: '', stderr: describeError(error) };
}

export interface UnixVoiceMediaHostOptions {
  socketPath: string;
  internalToken: string;
}

export class UnixVoiceMediaHostConnection implements IVoiceMediaHostConnection {
  public constructor(private readonly options: UnixVoiceMediaHostOptions) {}

  public async startCapture(captureId: string, configuration: VoiceMediaCaptureConfiguration): Promise<void> {
    await this.expect(this.request('POST', VOICE_MEDIA_ROUTES.hostCaptureStart, { captureId, configuration }), 201);
  }

  public async readCapture(captureId: string): Promise<VoiceMediaAudioPoll> {
    const response = await this.request(
      'GET',
      `${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=${encodeURIComponent(captureId)}`,
    );
    if (response.status === 200 && response.headers['content-type']?.startsWith(VOICE_MEDIA_CONTENT_TYPE)) {
      const activity = this.captureActivity(response.headers);
      return { pcm: response.body, state: 'active' as const, ...(activity === undefined ? {} : { activity }) };
    }
    if (response.status === 204) {
      const rawState = response.headers['x-doompi-capture-state'];
      const state: VoiceMediaAudioPoll['state'] =
        rawState === 'stopping' || rawState === 'stopped' ? rawState : 'active';
      return { pcm: Buffer.alloc(0), state };
    }
    throw this.responseError(response);
  }

  public async stopCapture(captureId: string): Promise<void> {
    await this.expect(this.request('POST', VOICE_MEDIA_ROUTES.hostCaptureStop, { captureId }), 204);
  }

  public async abortCapture(captureId: string): Promise<void> {
    await this.expect(this.request('POST', VOICE_MEDIA_ROUTES.hostCaptureAbort, { captureId }), 204);
  }

  public async startPlayback(request: {
    playbackId: string;
    text: string;
    voice?: string;
    rate?: number;
  }): Promise<VoiceMediaPlaybackDelivery> {
    const response = await this.request('POST', VOICE_MEDIA_ROUTES.hostPlaybackStart, request);
    if (response.status !== 201) throw this.responseError(response);
    const parsed: unknown = JSON.parse(response.body.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('delivery' in parsed) ||
      (parsed.delivery !== 'client' && parsed.delivery !== 'streamed')
    )
      throw new Error('Voice media host returned an invalid playback delivery.');
    return parsed.delivery;
  }

  public async sendPlaybackAudio(playbackId: string, pcm: Buffer): Promise<void> {
    await this.expect(
      this.requestBinary(
        'POST',
        `${VOICE_MEDIA_ROUTES.hostPlaybackAudio}?playbackId=${encodeURIComponent(playbackId)}`,
        pcm,
      ),
      204,
    );
  }

  public async sealPlaybackAudio(playbackId: string, error?: string): Promise<void> {
    await this.expect(
      this.request('POST', VOICE_MEDIA_ROUTES.hostPlaybackAudioEnd, {
        playbackId,
        ...(error === undefined ? {} : { error }),
      }),
      204,
    );
  }

  public async readPlayback(playbackId: string): Promise<VoiceMediaPlaybackResult | undefined> {
    const response = await this.request(
      'GET',
      `${VOICE_MEDIA_ROUTES.hostPlaybackResult}?playbackId=${encodeURIComponent(playbackId)}`,
    );
    if (response.status === 204) return undefined;
    if (response.status !== 200) throw this.responseError(response);
    const parsed: unknown = JSON.parse(response.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('outcome' in parsed))
      throw new Error('Voice media client returned an invalid playback result.');
    return parsed as VoiceMediaPlaybackResult;
  }

  public async stopPlayback(playbackId: string): Promise<void> {
    await this.expect(this.request('POST', VOICE_MEDIA_ROUTES.hostPlaybackStop, { playbackId }), 204);
  }

  public async abortPlayback(playbackId: string): Promise<void> {
    await this.expect(this.request('POST', VOICE_MEDIA_ROUTES.hostPlaybackAbort, { playbackId }), 204);
  }

  private request(method: string, route: string, json?: object): Promise<UnixResponse> {
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json), 'utf8');
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: `${DOOM_API_ROUTE_PREFIX}/${VOICE_MEDIA_API_BASE_PATH}${route}`,
          method,
          headers: {
            authorization: `Bearer ${this.options.internalToken}`,
            ...(body === undefined
              ? {}
              : { 'content-type': JSON_CONTENT_TYPE, 'content-length': String(body.byteLength) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () =>
            resolve({ status: response.statusCode ?? 500, headers: response.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      request.once('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  private requestBinary(method: string, route: string, body: Buffer): Promise<UnixResponse> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: `${DOOM_API_ROUTE_PREFIX}/${VOICE_MEDIA_API_BASE_PATH}${route}`,
          method,
          headers: {
            authorization: `Bearer ${this.options.internalToken}`,
            'content-type': VOICE_MEDIA_CONTENT_TYPE,
            'content-length': String(body.byteLength),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () =>
            resolve({ status: response.statusCode ?? 500, headers: response.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      request.once('error', reject);
      request.write(body);
      request.end();
    });
  }

  private captureActivity(headers: http.IncomingHttpHeaders): VoiceMediaCaptureActivity | undefined {
    const state = headers[VOICE_MEDIA_ACTIVITY_STATE_HEADER];
    if (state === undefined) return undefined;
    const levelDbfs = Number(headers[VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]);
    const elapsedMs = Number(headers[VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]);
    const epochHeader = headers[VOICE_MEDIA_ACTIVITY_EPOCH_HEADER];
    const speechMsHeader = headers[VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER];
    const epoch = epochHeader === undefined ? undefined : Number(epochHeader);
    const classifiedSpeechMs = speechMsHeader === undefined ? undefined : Number(speechMsHeader);
    if (
      (state !== 'listening' && state !== 'speech' && state !== 'endpoint') ||
      !Number.isFinite(levelDbfs) ||
      !Number.isSafeInteger(elapsedMs) ||
      (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) ||
      (classifiedSpeechMs !== undefined && (!Number.isSafeInteger(classifiedSpeechMs) || classifiedSpeechMs < 0))
    )
      throw new Error('Voice media client returned invalid capture activity.');
    return {
      state,
      levelDbfs,
      elapsedMs,
      ...(epoch === undefined ? {} : { epoch }),
      ...(classifiedSpeechMs === undefined ? {} : { classifiedSpeechMs }),
    };
  }
  private async expect(pending: Promise<UnixResponse>, status: number): Promise<void> {
    const response = await pending;
    if (response.status !== status) throw this.responseError(response);
  }

  private responseError(response: UnixResponse): Error {
    let message = response.body.toString('utf8');
    try {
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string')
        message = parsed.error;
    } catch {
      // A non-JSON response body is already the best available diagnostic.
    }
    return new Error(message || `Voice media request failed with status ${String(response.status)}.`);
  }
}

export function voiceMediaHostConnection(
  environment: NodeJS.ProcessEnv = process.env,
): UnixVoiceMediaHostConnection | undefined {
  const socketPath = environment[DOOM_API_SOCKET_ENV];
  const internalToken = environment[DOOM_API_INTERNAL_TOKEN_ENV];
  return socketPath && internalToken ? new UnixVoiceMediaHostConnection({ socketPath, internalToken }) : undefined;
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
