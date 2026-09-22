import { defineCliCommand, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';

import type { HelpRuntimeOptions } from '../../../../../services/helpRuntime';
export default defineCliCommand(
  (context: WithRoot<PiPluginContext<HelpRuntimeOptions>, PiPluginContributions<HelpRuntimeOptions>>) =>
    context.root.commands![0]!,
);
