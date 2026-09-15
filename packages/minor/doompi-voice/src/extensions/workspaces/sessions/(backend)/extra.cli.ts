import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import type { VoiceExtensionOptions } from '../../../../services/voiceController';
import { createVoicePiRuntime } from '../../../../services/voiceControllerPlugin';

export default (({ context, pi, options }) => ({
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
})) satisfies (context: PiPluginContext<VoiceExtensionOptions>) => PiPluginContributions<VoiceExtensionOptions>;
