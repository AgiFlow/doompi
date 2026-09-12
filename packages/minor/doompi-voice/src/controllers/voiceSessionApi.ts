import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';
import { ExecutableResolver, NodeProcessSpawner, SystemClock, TemporaryWorkspace } from '../services/infrastructure';
import { api as voiceMediaApi, createVoiceMediaApi, type VoiceMediaApiOptions } from './clientMediaApi';
import { ManualTranscriptionConfigLoader } from '../services/manualTranscriptionConfig';
import { FfmpegEncodedAudioDecoder } from '../services/encodedAudio';
import { ManualTranscriptionApi } from './manualTranscriptionApi';
import { MlxWhisperAdapter, OpenAiWhisperAdapter, TranscriberRegistry, WhisperCppAdapter } from '../services/whisper';
import { ManualTranscriptionService } from '../services/manualTranscription';
import { MANUAL_TRANSCRIPTION_ROUTE, type IManualTranscriptionService } from '../types/manualTranscription';
import { VOICE_MEDIA_API_BASE_PATH } from '../types/clientMedia';

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

export function createVoiceSessionApi(options: VoiceSessionApiOptions): DoomApiHandler {
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
