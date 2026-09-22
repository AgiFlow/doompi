import type { DoomServerPluginDefinition, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

import { createHelpServerSession } from '../../../../../services/helpServerSession';

export default (({ agent }): Partial<DoomServerSessionPlugin> =>
  agent ? createHelpServerSession(agent) : {}) satisfies NonNullable<DoomServerPluginDefinition['session']>;
