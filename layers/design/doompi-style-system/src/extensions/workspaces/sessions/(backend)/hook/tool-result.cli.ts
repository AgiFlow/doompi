import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { StyleSystemPiScope } from '../_lib/piRoot';

export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, StyleSystemPiScope>): PiEventHandlers['tool_result'] =>
    context.root.toolResult,
);
