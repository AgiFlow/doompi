import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { HookPiScope } from '../_lib/piRoot';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, HookPiScope>): PiEventHandlers['session_shutdown'] =>
    context.root.session_shutdown,
);
