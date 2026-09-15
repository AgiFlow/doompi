import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import runtime from '../_lib/index.server';

export default defineRoutedContribution(
  (context: WithRoot<unknown, ReturnType<typeof runtime>>) => context.root.resources?.[1],
  { cardinality: 'optional' },
);
