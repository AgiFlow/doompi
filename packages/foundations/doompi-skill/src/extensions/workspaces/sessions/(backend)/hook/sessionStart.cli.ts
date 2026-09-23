import { defineCliHook } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createSkillRuntime } from '../_lib/skillRuntime';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createSkillRuntime>>) =>
    context.root.events!.session_start,
);
