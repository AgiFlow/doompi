import type { DoomServerPluginDefinition, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createHelpServerSession } from '../../../../../services/helpServerSession';

export default (({ agent }): Partial<DoomServerSessionPlugin> =>
  agent ? createHelpServerSession(agent) : {}) satisfies NonNullable<DoomServerPluginDefinition['session']>;
