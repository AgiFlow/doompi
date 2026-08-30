import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { ExecutableResolver, NodeProcessSpawner, SystemClock, TemporaryWorkspace } from './audio/infrastructure.ts';
import { api as voiceMediaApi, createVoiceMediaApi, type VoiceMediaApiOptions } from './clientMediaApi.ts';
import { ManualTranscriptionConfigLoader } from './config/manualTranscriptionConfig.ts';
import { FfmpegEncodedAudioDecoder } from './audio/encodedAudio.ts';
import { ManualTranscriptionApi } from './manualTranscriptionApi.ts';
import {
  MlxWhisperAdapter,
  OpenAiWhisperAdapter,
  TranscriberRegistry,
  WhisperCppAdapter,
} from './transcription/whisper.ts';
import { ManualTranscriptionService } from '../services/manualTranscription.ts';
import { MANUAL_TRANSCRIPTION_ROUTE, type IManualTranscriptionService } from '../types/manualTranscription.ts';
import { VOICE_MEDIA_API_BASE_PATH } from '../types/clientMedia.ts';

export interface VoiceSessionApiOptions extends VoiceMediaApiOptions {
  manualTranscription?: IManualTranscriptionService;
  projectRoot?: string;
}

class VoiceSessionApi implements DoomApiHandler {
  private readonly manual: ManualTranscriptionApi;

  public constructor(
    private readonly media: DoomApiHandler,
    service: IManualTranscriptionService,
  ) {
    this.manual = new ManualTranscriptionApi(service);
  }

  public fetch(request: Request): Response | Promise<Response> {
    return new URL(request.url).pathname === MANUAL_TRANSCRIPTION_ROUTE
      ? this.manual.fetch(request)
      : this.media.fetch(request);
  }

  public close(): void {
    this.manual.close();
    this.media.close();
  }
}

function createDefaultManualTranscriptionService(projectRoot: string): IManualTranscriptionService {
  const executables = new ExecutableResolver();
  const spawner = new NodeProcessSpawner();
  const registry = new TranscriberRegistry(
    new WhisperCppAdapter(executables, spawner),
    new OpenAiWhisperAdapter(executables, spawner),
    new MlxWhisperAdapter(executables, spawner),
  );
  return new ManualTranscriptionService(
    new ManualTranscriptionConfigLoader(projectRoot),
    new FfmpegEncodedAudioDecoder(executables, spawner),
    registry,
    new TemporaryWorkspace(),
    new SystemClock(),
  );
}

export function createVoiceSessionApi(options: VoiceSessionApiOptions = {}): DoomApiHandler {
  const { manualTranscription, projectRoot = process.cwd(), ...mediaOptions } = options;
  return new VoiceSessionApi(
    createVoiceMediaApi(mediaOptions),
    manualTranscription ?? createDefaultManualTranscriptionService(projectRoot),
  );
}

export const api: DoomApi = {
  basePath: VOICE_MEDIA_API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    return new VoiceSessionApi(
      voiceMediaApi.start(context),
      createDefaultManualTranscriptionService(context.cwd ?? process.cwd()),
    );
  },
};
