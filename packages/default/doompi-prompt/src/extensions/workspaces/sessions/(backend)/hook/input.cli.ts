import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createInputCapture } from '../../../../../services/inputCapture';
import type { PromptPiScope } from '../_lib/piRoot';
export default defineCliHook((context: WithRoot<PiPluginContext<unknown>, PromptPiScope>) =>
  createInputCapture(context.root.recent),
);
