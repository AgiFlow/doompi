import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

export default defineRoutedContribution(
  {
    path: [
      { key: 'h', label: 'help', detail: 'package docs and logs' },
      { key: 'e', label: 'toggle', detail: 'load or hide package Help' },
    ],
    command: 'minor help',
  },
  {},
);
