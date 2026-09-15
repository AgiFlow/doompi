import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
export default defineRoutedContribution(
  { name: 'profile', command: 'profile', statusKey: 'doom-profile', emptyLabel: 'no profile', order: 10 },
  {},
);
