import { loadDoomConfigLayers, resolveVoiceConfig } from '@agimon-ai/doompi-config';

import { ExecutableResolver, NodeProcessSpawner } from '../infrastructure';
import { MlxWhisperAdapter, OpenAiWhisperAdapter, TranscriberRegistry, WhisperCppAdapter } from '../whisper';

/** Local preflight only. Does not open a microphone, transcribe, or call a model provider. */
export function voiceReadiness(
  repoRoot: string | undefined,
  homeDirectory: string,
  environment?: Readonly<Record<string, string | undefined>>,
) {
  try {
    const voice = loadDoomConfigLayers(repoRoot, homeDirectory).effective.voice;
    if (!voice)
      return { configured: false, transcription: false, error: 'Configure Voice in settings before starting capture.' };
    const config = resolveVoiceConfig(voice);
    const executables = new ExecutableResolver(environment?.PATH);
    const spawner = new NodeProcessSpawner();
    const registry = new TranscriberRegistry(
      new WhisperCppAdapter(executables, spawner),
      new OpenAiWhisperAdapter(executables, spawner),
      new MlxWhisperAdapter(executables, spawner),
    );
    const selected = registry.select(config);
    executables.resolve(config.recorder.binary, 'ffmpeg');
    return {
      configured: true,
      transcription: true,
      engine: selected.adapter.engine,
      mode: voice.mode ?? 'legacy',
      correctionModel: config.autoCapture?.model,
    };
  } catch (error) {
    return { configured: true, transcription: false, error: error instanceof Error ? error.message : String(error) };
  }
}
