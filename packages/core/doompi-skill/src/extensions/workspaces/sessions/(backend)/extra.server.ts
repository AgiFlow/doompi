import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createSkillServer } from './_lib/skillServer';

export default ({ agent, signal }: DoomServerPluginContext) => (agent ? createSkillServer(agent, signal) : {});
