import { loadDoomConfig, resolveVoiceConfig } from '@agimon-ai/doompi-config';
import { ManualTranscriptionError, type IManualTranscriptionConfigLoader } from '../../types/manualTranscription.ts';

export class ManualTranscriptionConfigLoader implements IManualTranscriptionConfigLoader {
  public constructor(private readonly projectRoot: string) {}

  public load() {
    const voice = loadDoomConfig(this.projectRoot).voice;
    if (!voice) throw new ManualTranscriptionError('unavailable', 'Voice transcription is not configured.');
    return resolveVoiceConfig(voice);
  }
}
