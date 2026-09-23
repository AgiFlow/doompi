import { defineCliCommand } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createProfileRuntime } from '../_lib/profileRuntime';
export default defineCliCommand(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createProfileRuntime>>) => context.root.commands![0]!,
);
