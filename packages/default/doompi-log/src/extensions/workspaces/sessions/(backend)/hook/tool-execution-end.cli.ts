import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { LogPiScope } from '../_lib/piRoot';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, LogPiScope>): PiEventHandlers['tool_execution_end'] =>
    context.root.telemetry.events.tool_execution_end,
  {},
);
