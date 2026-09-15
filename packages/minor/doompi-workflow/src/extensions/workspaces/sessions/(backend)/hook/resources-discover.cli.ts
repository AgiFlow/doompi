import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';

import runtime from '../_lib/index.cli';

export default defineRoutedContribution(
  (
    context: WithRoot<unknown, ReturnType<typeof runtime>>,
  ): NonNullable<PiEventHandlers['resources_discover']> | undefined => context.root.events?.resources_discover,
  { cardinality: 'optional' },
);
