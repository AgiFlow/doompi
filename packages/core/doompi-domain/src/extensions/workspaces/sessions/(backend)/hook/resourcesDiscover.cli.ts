import { defineCliHook } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import { createDomainRuntime } from '../_lib/domainRuntime';
export default defineCliHook(
  (
    context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createDomainRuntime>>,
  ): NonNullable<PiPluginContributions['events']>['resources_discover'] => context.root.events!.resources_discover,
);
