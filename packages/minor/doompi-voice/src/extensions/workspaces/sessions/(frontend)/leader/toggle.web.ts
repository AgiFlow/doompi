import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  id: 'voice.toggle',
  path: [
    { key: 'v', label: 'voice', detail: 'autonomous voice capture' },
    { key: 'e', label: 'toggle', detail: 'start or stop autonomous capture' },
  ],
  command: 'minor voice-auto',
});
