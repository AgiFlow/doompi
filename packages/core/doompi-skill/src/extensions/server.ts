import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createSkillServer } from '../controllers/skillServer';
import { LEADER_SOURCE } from '../types/skills';
export const skillServerFacet = defineServerPlugin({
  name: LEADER_SOURCE,
  session: ({ agent, signal }) => (agent ? createSkillServer(agent, signal) : {}),
});

export default skillServerFacet;
