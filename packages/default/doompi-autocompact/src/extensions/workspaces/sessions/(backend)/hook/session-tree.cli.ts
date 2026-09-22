import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { AutocompactScope } from '../_lib/piRoot';

export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, AutocompactScope>): PiEventHandlers['session_tree'] =>
    context.root.events.session_tree,
);
