import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { HookPiScope } from '../_lib/piRoot';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, HookPiScope>): PiEventHandlers['before_agent_start'] =>
    context.root.before_agent_start,
);
