import type { DoomDirectEventBus } from '@agimon-ai/doompi-core/hubChannel';

import { createVoiceMediaApi, type VoiceMediaApiOptions } from '../src/services/clientMediaApi';
import { createVoiceSessionApi, type VoiceSessionApiOptions } from '../src/services/voiceSessionApi';

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
