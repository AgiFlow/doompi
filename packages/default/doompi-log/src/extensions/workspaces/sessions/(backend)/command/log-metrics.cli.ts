import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { LogPiScope } from '../_lib/piRoot';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, LogPiScope>) => [context.root.view.commands[0]] as const,
  { cardinality: 'many' },
);
