import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createSessionState } from '../../../../controllers/serverRuntime';

export default (({ agent }) => (agent ? createSessionState(agent) : {})) satisfies NonNullable<
  DoomServerPluginDefinition['session']
>;
