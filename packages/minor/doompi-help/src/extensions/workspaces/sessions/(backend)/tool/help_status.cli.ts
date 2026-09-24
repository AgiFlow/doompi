import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

import type { HelpRuntimeOptions } from '../../../../../services/helpRuntime';

export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<HelpRuntimeOptions>, PiPluginContributions<HelpRuntimeOptions>>) => {
    const tools = context.root.tools;
    return tools && !('snapshot' in tools) ? tools[0] : undefined;
  },
  { cardinality: 'optional' },
);
