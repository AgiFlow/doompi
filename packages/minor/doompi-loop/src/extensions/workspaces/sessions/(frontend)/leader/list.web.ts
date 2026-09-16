import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  path: [
    { key: 'l', label: 'loops', detail: 'recurring prompt loops' },
    { key: 'l', label: 'list', detail: 'loops in this session' },
  ],
  command: 'loops',
});
