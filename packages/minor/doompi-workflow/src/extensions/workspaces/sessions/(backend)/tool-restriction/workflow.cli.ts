import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import runtime from '../_lib/index.cli';

export default defineRoutedContribution(
  (context: WithRoot<unknown, ReturnType<typeof runtime>>) => context.root.toolRestrictions,
  { cardinality: 'many' },
);
