import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createDomainRuntime } from '../_lib/domainRuntime';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createDomainRuntime>>) => context.root.commands![0]!,
  {},
);
