import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

export default defineRoutedContribution(
  {
    path: [
      { key: 'g', label: 'goal', detail: 'session objective' },
      { key: 'e', label: 'toggle', detail: 'start a session goal or end the current one' },
    ],
    command: 'minor goal',
  },
  {},
);
