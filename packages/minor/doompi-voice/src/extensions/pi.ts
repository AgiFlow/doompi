import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createVoicePiRuntime } from '../controllers/voicePlugin';
import type { VoiceExtensionOptions } from '../controllers/voice';
export const voicePiExtension = definePiExtension<VoiceExtensionOptions>(
  '@agimon-ai/doompi-voice',
  ({ context, pi, options }) => ({
    ...createVoicePiRuntime(context, pi, options ?? {}),
    resources: [
      {
        source: '@agimon-ai/doompi-voice',
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-use-voice',
            description:
              'Use Doom Pi Voice for manual transcription, autonomous capture, narration, configuration, and recovery on macOS.',
          },
        ],
      },
    ],
  }),
);
export default voicePiExtension;
