import { defineCliHook } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { UiPiScope } from '../_lib/piScope';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, UiPiScope>) => context.root.ui.events.session_start!,
);
