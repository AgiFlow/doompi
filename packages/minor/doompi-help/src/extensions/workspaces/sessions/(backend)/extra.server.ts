import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createHelpServerSession } from '../../../../controllers/helpServerSession';

export default (({ agent }) => (agent ? createHelpServerSession(agent) : {})) satisfies NonNullable<
  DoomServerPluginDefinition['session']
>;
