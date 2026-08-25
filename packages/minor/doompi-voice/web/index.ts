import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { VoiceActivitySection } from './VoiceActivitySection.tsx';
import { VoiceToolMessage } from './VoiceToolMessage.tsx';
import { VOICE_TOOL_NAMES } from './voiceToolRender.ts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'doom-voice' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'voice',
  minorModes: [{ name: 'voice', keys: 'v e', statusKey: 'doom-voice', order: 60 }],
  // A microphone you cannot see is one you cannot trust, so voice earns a
  // group in the dock rather than a word inside a chip.
  activityGroups: [{ name: 'voice', keys: 'v e', statusKey: 'doom-voice', order: 60 }],
  // Same name as the group: the dock renders this inside it, in place of the
  // raw status line the session publishes for a terminal footer.
  activitySections: [{ id: 'voice', component: VoiceActivitySection }],
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
