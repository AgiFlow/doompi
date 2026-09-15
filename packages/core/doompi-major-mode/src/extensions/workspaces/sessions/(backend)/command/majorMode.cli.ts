import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createMajorModeRuntime } from '../_lib/majorModeRuntime';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createMajorModeRuntime>>) =>
    context.root.commands![0]!,
  {},
);
