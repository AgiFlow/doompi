import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  path: [
    { key: 'l', label: 'loops', detail: 'recurring prompt loops' },
    { key: 's', label: 'start', detail: 'begin a recurring loop' },
  ],
  command: 'loop',
});
