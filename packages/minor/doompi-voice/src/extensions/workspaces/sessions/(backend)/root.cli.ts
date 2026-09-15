import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { VoiceExtensionOptions } from '../../../../services/voiceController';
import { createVoicePiRuntime } from '../../../../services/voicePlugin';

export default defineRoot(({ context, pi, options }: PiPluginContext<VoiceExtensionOptions>) => {
  const value = {
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
  };
  return {
    value,
    services: value.services,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
