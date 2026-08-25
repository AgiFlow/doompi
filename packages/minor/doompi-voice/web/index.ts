import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { VoiceToolMessage } from './VoiceToolMessage.tsx';
import { VOICE_TOOL_NAMES } from './voiceToolRender.ts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'doom-voice' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'voice',
  minorModes: [{ name: 'voice', keys: 'v e', statusKey: 'doom-voice', order: 60 }],
  // The voice tools' timeline cards, the web half of src/adapters/pi/voiceToolRender.ts.
  toolRenderers: [{ tools: [...VOICE_TOOL_NAMES], message: VoiceToolMessage }],
  // The TUI's SPC v e through /minor; one-shot dictation (v v) needs the TUI's microphone.
  leaderBindings: [
    {
      id: 'voice.toggle',
      path: [
        { key: 'v', label: 'voice', detail: 'autonomous voice capture' },
        { key: 'e', label: 'toggle', detail: 'start or stop autonomous capture' },
      ],
      command: 'minor voice',
    },
  ],
});
