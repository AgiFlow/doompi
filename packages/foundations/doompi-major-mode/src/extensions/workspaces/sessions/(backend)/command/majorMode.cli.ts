import { defineCliCommand } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createMajorModeRuntime } from '../_lib/majorModeRuntime';
export default defineCliCommand(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createMajorModeRuntime>>) =>
    context.root.commands![0]!,
);
