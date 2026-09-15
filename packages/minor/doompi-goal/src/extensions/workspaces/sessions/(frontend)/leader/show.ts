import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  path: [
    { key: 'g', label: 'goal', detail: 'session objective' },
    { key: 'g', label: 'current', detail: 'the goal being worked' },
  ],
  command: 'goal status',
});
