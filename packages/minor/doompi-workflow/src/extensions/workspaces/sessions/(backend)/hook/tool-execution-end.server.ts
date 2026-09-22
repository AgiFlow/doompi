import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import runtime from '../_lib/index.server';

export default defineRoutedContribution(
  (context: WithRoot<unknown, ReturnType<typeof runtime>>) => context.root.hooks?.[0],
  { cardinality: 'optional' },
);
