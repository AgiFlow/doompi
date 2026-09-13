import { loadDoomConfig, resolveVoiceConfig } from '@agimon-ai/doompi-config';

import { ManualTranscriptionError, type IManualTranscriptionConfigLoader } from '../../types/manualTranscription';

export class ManualTranscriptionConfigLoader implements IManualTranscriptionConfigLoader {
  public constructor(
    private readonly projectRoot: string,
    private readonly homeDirectory?: string,
  ) {}

  public load() {
    const voice = loadDoomConfig(this.projectRoot, this.homeDirectory).voice;
    if (!voice) throw new ManualTranscriptionError('unavailable', 'Voice transcription is not configured.');
    return resolveVoiceConfig(voice);
  }
}
