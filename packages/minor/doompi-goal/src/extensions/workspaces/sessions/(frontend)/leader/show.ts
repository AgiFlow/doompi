import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

export default defineRoutedContribution(
  {
    path: [
      { key: 'g', label: 'goal', detail: 'session objective' },
      { key: 'g', label: 'current', detail: 'the goal being worked' },
    ],
    command: 'goal status',
  },
  {},
);
