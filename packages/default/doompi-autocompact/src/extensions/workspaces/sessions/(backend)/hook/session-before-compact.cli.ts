import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { AutocompactScope } from '../_lib/piRoot';

export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, AutocompactScope>): PiEventHandlers['session_before_compact'] =>
    context.root.events.session_before_compact,
);
