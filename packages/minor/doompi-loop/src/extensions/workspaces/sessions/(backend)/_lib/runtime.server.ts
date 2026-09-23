import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/serverFacet';

import { createSessionState, type LoopServerState } from '../../../../../services/serverRuntime';

export default (({ agent }): LoopServerState =>
  agent ? createSessionState(agent) : { loopTools: [] }) satisfies NonNullable<DoomServerPluginDefinition['session']>;
