import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers } from '@agimon-ai/doompi-core/piExtension';

import runtime from '../_lib/index.cli';

export default defineRoutedContribution(
  (
    context: WithRoot<unknown, ReturnType<typeof runtime>>,
  ): NonNullable<PiEventHandlers['resources_discover']> | undefined => context.root.events?.resources_discover,
  { cardinality: 'optional' },
);
