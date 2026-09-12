import type { DoomDirectEventBus } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { createVoiceMediaApi, type VoiceMediaApiOptions } from '../src/controllers/clientMediaApi';
import { createVoiceSessionApi, type VoiceSessionApiOptions } from '../src/controllers/voiceSessionApi';

export const testDirectEvents: DoomDirectEventBus = {
  publish: () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
};

type TestMediaOptions = Omit<VoiceMediaApiOptions, 'directEvents'> & { directEvents?: DoomDirectEventBus };
type TestSessionOptions = Omit<VoiceSessionApiOptions, 'directEvents'> & { directEvents?: DoomDirectEventBus };

export function createTestVoiceMediaApi(options: TestMediaOptions = {}) {
  return createVoiceMediaApi({ ...options, directEvents: options.directEvents ?? testDirectEvents });
}

export function createTestVoiceSessionApi(options: TestSessionOptions) {
  return createVoiceSessionApi({ ...options, directEvents: options.directEvents ?? testDirectEvents });
}
