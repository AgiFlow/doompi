import type { DoomServerPluginDefinition, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

import { createGoalServer } from '../../../../../services/goalServer';

export default (({ agent }): Partial<DoomServerSessionPlugin> =>
  agent ? createGoalServer(agent) : {}) satisfies NonNullable<DoomServerPluginDefinition['session']>;
