import { defineCliHook } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createSkillRuntime } from '../_lib/skillRuntime';
export default defineCliHook(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createSkillRuntime>>) =>
    context.root.events!.before_agent_start,
);
