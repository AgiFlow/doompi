import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

export default defineRoutedContribution(
  {
    source: '@agimon-ai/doompi-runner',
    moduleUrl: import.meta.url,
    skills: [
      {
        name: 'doompi-use-runner',
        description:
          'Use Doom Pi Runner to supervise shell commands, inspect durable logs, provide interactive input, and stop background runs.',
      },
    ],
  },
  {},
);
