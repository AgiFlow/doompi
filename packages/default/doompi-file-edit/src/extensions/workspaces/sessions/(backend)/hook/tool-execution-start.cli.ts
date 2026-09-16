import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { FileEditPiScope } from '../_lib/piRoot';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, FileEditPiScope>) => context.root.events!.tool_execution_start!,
);
