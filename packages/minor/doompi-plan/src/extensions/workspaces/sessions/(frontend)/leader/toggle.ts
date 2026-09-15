import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  id: 'plan.toggle',
  path: [
    { key: 'p', label: 'plan', detail: 'read-only planning modes' },
    { key: 'e', label: 'toggle', detail: 'enter or leave read-only planning' },
  ],
  command: 'minor plan',
});
