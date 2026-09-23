import { defineCliHook } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createDomainRuntime } from '../_lib/domainRuntime';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createDomainRuntime>>) =>
    context.root.events!.session_shutdown,
);
