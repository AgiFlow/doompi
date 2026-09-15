import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  path: [
    { key: 'g', label: 'goal', detail: 'session objective' },
    { key: 'e', label: 'toggle', detail: 'start a session goal or end the current one' },
  ],
  command: 'minor goal',
});
