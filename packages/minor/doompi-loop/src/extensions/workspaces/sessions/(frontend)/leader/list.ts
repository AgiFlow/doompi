import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

export default defineRoutedContribution(
  {
    path: [
      { key: 'l', label: 'loops', detail: 'recurring prompt loops' },
      { key: 'l', label: 'list', detail: 'loops in this session' },
    ],
    command: 'loops',
  },
  {},
);
