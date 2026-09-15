import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { api } from '../../../../controllers/planApi';
import { createPlanServerSession } from '../../../../controllers/planServerSession';

const session: NonNullable<DoomServerPluginDefinition['session']> = ({ agent }) => ({
  api: [api],
  ...(agent ? createPlanServerSession(agent) : {}),
});

export default session;
