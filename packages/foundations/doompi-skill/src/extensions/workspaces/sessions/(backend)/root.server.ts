import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createSkillServer } from './_lib/skillServer';

export default defineRoot(async ({ agent, signal }: DoomServerPluginContext) => {
  const runtime: DoomServerSessionPlugin = agent
    ? await createSkillServer(agent, signal)
    : { commands: [], resources: [] };
  return { value: runtime, services: runtime.services };
});
