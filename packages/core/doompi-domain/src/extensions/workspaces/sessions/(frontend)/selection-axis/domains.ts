import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
export default defineRoutedContribution(
  {
    name: 'domains',
    command: 'domains',
    statusKey: 'doom-domain',
    emptyLabel: 'no domains',
    multi: true,
    order: 20,
  },
  {},
);
