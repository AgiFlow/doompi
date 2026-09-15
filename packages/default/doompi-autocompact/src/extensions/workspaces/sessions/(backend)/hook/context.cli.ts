import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { AutocompactScope } from '../_lib/piRoot';

export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, AutocompactScope>): PiEventHandlers['context'] =>
    context.root.events.context,
  {},
);
