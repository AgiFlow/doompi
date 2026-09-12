import { type VoiceDependencies } from '../../types';
import {
  ExecutableResolver,
  FfmpegAudioRecorder,
  FfmpegPcmAudioRecorder,
  MacOsSayPcmSynthesizer,
  MacOsSayTtsAdapter,
  NodeBinaryProcessSpawner,
  NodeProcessSpawner,
  PcmWavAnalyzer,
  SystemClock,
} from '../infrastructure';
import { ClientPcmAudioRecorder, ClientTtsAdapter, voiceMediaHostConnection } from '../clientMedia';
import { VoiceWorkerSessionController } from '../voiceWorkerSessionController';
import { MlxWhisperAdapter, OpenAiWhisperAdapter, TranscriberRegistry, WhisperCppAdapter } from '../whisper';
import { PiVoiceConfigService } from '../voiceConfig';

export function createVoiceDependencies(overrides: Partial<VoiceDependencies> = {}): VoiceDependencies {
  const clock = overrides.clock ?? new SystemClock();
  const executables = overrides.executables ?? new ExecutableResolver();
  const spawner = overrides.spawner ?? new NodeProcessSpawner();
  const binarySpawner = overrides.binarySpawner ?? new NodeBinaryProcessSpawner();
  const clientMedia = voiceMediaHostConnection(overrides.clientMedia);

  const configs = overrides.configs ?? new PiVoiceConfigService();
  const whisperCpp = overrides.whisperCpp ?? new WhisperCppAdapter(executables, spawner);
  const openAiWhisper = overrides.openAiWhisper ?? new OpenAiWhisperAdapter(executables, spawner);
  const mlxWhisper = overrides.mlxWhisper ?? new MlxWhisperAdapter(executables, spawner);
  const registry = overrides.registry ?? new TranscriberRegistry(whisperCpp, openAiWhisper, mlxWhisper);

  return {
    ...(clientMedia === undefined ? {} : { clientMedia }),
    clock,
    executables,
    spawner,
    binarySpawner,
    configs,
    recorder: overrides.recorder ?? new FfmpegAudioRecorder(executables, spawner, clock),
    pcmRecorder:
      overrides.pcmRecorder ??
      (clientMedia
        ? new ClientPcmAudioRecorder(clientMedia)
        : new FfmpegPcmAudioRecorder(executables, binarySpawner, clock)),
    tts:
      overrides.tts ??
      (clientMedia
        ? new ClientTtsAdapter(clientMedia, clock, new MacOsSayPcmSynthesizer(executables, binarySpawner))
        : new MacOsSayTtsAdapter(executables, binarySpawner, clock)),
    analyzer: overrides.analyzer ?? new PcmWavAnalyzer(),
    whisperCpp,
    openAiWhisper,
    mlxWhisper,
    registry,
    sessionController: overrides.sessionController ?? new VoiceWorkerSessionController(configs, clock),
  };
}
