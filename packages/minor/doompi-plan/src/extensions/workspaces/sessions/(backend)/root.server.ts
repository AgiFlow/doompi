import { defineRoot, type RootDeclaration } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

import { api } from '../../../../services/planApi';
import { createPlanServerSession } from '../../../../services/planServerSession';

export default defineRoot(
  ({ agent }: DoomServerPluginContext): RootDeclaration<DoomServerSessionPlugin, DoomServerPluginContext> => {
    const value = {
      api: [api],
      ...(agent ? createPlanServerSession(agent) : {}),
    };
    return { value, services: value.services };
  },
);
