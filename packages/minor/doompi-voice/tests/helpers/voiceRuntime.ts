import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createVoiceRuntime, type VoiceExtensionOptions } from '../../src/services/voice';
import { createVoiceRuntime as createPublicVoiceRuntime } from '../../src/services/voiceController';

export const voiceRuntime = definePiExtension<VoiceExtensionOptions>('voice-runtime-test', ({ pi, options }) =>
  createVoiceRuntime(pi, options ?? {}),
);

export const publicVoiceRuntime = definePiExtension<VoiceExtensionOptions>(
  'voice-public-runtime-test',
  ({ pi, options }) => createPublicVoiceRuntime(pi, options ?? {}),
);
