import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createVoiceRuntime, type VoiceExtensionOptions } from '../../src/controllers/voice';
export const voiceRuntime = definePiExtension<VoiceExtensionOptions>('voice-runtime-test', ({ pi, options }) =>
  createVoiceRuntime(pi, options ?? {}),
);
