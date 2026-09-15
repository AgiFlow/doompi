import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createSkillServer } from '../../../../controllers/skillServer';

export default ({ agent, signal }: DoomServerPluginContext) => (agent ? createSkillServer(agent, signal) : {});
