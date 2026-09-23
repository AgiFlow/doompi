import { defineCliCommand } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createSkillRuntime } from '../_lib/skillRuntime';
export default defineCliCommand(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createSkillRuntime>>) => context.root.commands![0]!,
);
