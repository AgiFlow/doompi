import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { UiPiScope } from '../_lib/piScope';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, UiPiScope>) => context.root.ui.commands[1],
  {},
);
