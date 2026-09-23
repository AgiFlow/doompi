import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { LogPiScope } from '../_lib/piRoot';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, LogPiScope>): PiEventHandlers['tool_execution_start'] =>
    context.root.telemetry.events.tool_execution_start,
);
