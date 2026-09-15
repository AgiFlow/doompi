import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

export default defineLeaderBinding({
  path: [
    { key: 'h', label: 'help', detail: 'package docs and logs' },
    { key: 'e', label: 'toggle', detail: 'load or hide package Help' },
  ],
  command: 'minor help',
});
