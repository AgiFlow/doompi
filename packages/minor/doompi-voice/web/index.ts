import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { VoiceActivitySection } from './VoiceActivitySection.tsx';
import { VoiceComposerAction } from './VoiceComposerAction.tsx';
import { startVoiceMediaRuntime } from './VoiceMediaRuntime.tsx';
import { VoiceToolMessage } from './VoiceToolMessage.tsx';
import { VOICE_DESCRIBE_TOOL, VOICE_NARRATE_TOOL, VOICE_TRANSFER_TOOL, VOICE_USE_TOOL } from './voiceToolRender.ts';
import { voiceMediaWakeChannel, voiceOwnershipChannel } from './voiceMediaWakeStore.ts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'doom-voice' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'voice',
  channels: [voiceMediaWakeChannel, voiceOwnershipChannel],
  start: startVoiceMediaRuntime,
  // `v e` drives autonomous capture through the browser runtime and leaves
  // one-shot manual dictation exclusively on the visible Composer button.
  minorModes: [{ name: 'voice', modeId: 'voice-auto', keys: 'v e', statusKey: 'doom-voice', order: 60 }],
  // A microphone you cannot see is one you cannot trust, so voice earns a
  // group in the dock rather than a word inside a chip. Autonomous capture is
  // an interactive session mode, not background work, so it must not increment
  // the dock's running count or hold the background-work notice open.
  // hideWhenEmpty keeps the group present only while voice reports activity.
  activityGroups: [
    {
      name: 'voice',
      keys: 'v e',
      statusKey: 'doom-voice',
      hideWhenEmpty: true,
      marksBackgroundWork: false,
      placement: 'bottom',
      order: 60,
    },
  ],
  // Same name as the group: the dock renders this inside it, in place of the
  // raw status line the session publishes for a terminal footer.
  activitySections: [{ id: 'voice', component: VoiceActivitySection }],
  composerActions: [{ id: 'voice', component: VoiceComposerAction }],
  // Narration reads as conversational output; the remaining façade calls keep
  // the ordinary tool presentation because they expose implementation detail.
  toolRenderers: [
    {
      tools: [VOICE_DESCRIBE_TOOL, VOICE_USE_TOOL, VOICE_TRANSFER_TOOL],
      message: VoiceToolMessage,
    },
    {
      tools: [VOICE_NARRATE_TOOL],
      timelinePresentation: 'message',
      message: VoiceToolMessage,
    },
  ],
  // The browser leader binding controls autonomous capture only.
  leaderBindings: [
    {
      id: 'voice.toggle',
      path: [
        { key: 'v', label: 'voice', detail: 'autonomous voice capture' },
        { key: 'e', label: 'toggle', detail: 'start or stop autonomous capture' },
      ],
      command: 'minor voice-auto',
    },
  ],
});
