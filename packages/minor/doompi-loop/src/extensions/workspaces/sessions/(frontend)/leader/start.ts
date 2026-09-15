import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

export default defineRoutedContribution(
  {
    path: [
      { key: 'l', label: 'loops', detail: 'recurring prompt loops' },
      { key: 's', label: 'start', detail: 'begin a recurring loop' },
    ],
    command: 'loop',
  },
  {},
);
