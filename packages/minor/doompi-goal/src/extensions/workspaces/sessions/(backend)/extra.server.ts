import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createGoalServer } from '../../../../controllers/goalServer';

export default (({ agent }) => (agent ? createGoalServer(agent) : {})) satisfies NonNullable<
  DoomServerPluginDefinition['session']
>;
