import type { DoomServerPluginDefinition, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

import { createSessionState } from '../../../../../services/serverRuntime';

export default (({ agent }): Partial<DoomServerSessionPlugin> =>
  agent ? createSessionState(agent) : {}) satisfies NonNullable<DoomServerPluginDefinition['session']>;
