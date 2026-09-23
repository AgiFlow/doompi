import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { LogPiScope } from '../_lib/piRoot';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, LogPiScope>): PiEventHandlers['before_agent_start'] =>
    context.root.telemetry.events.before_agent_start,
);
