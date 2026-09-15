import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import type { HelpRuntimeOptions } from '../../../../../services/helpRuntime';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<HelpRuntimeOptions>, PiPluginContributions<HelpRuntimeOptions>>) =>
    context.root.commands![0]!,
  {},
);
