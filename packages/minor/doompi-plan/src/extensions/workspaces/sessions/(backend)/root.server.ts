import { defineRoot, type RootDeclaration } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext, DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';

import { mountMcpTools } from '../../../../services/mcpTools';
import { api } from '../../../../services/planApi';
import { createPlanServerSession } from '../../../../services/planServerSession';

export default defineRoot(
  ({ agent }: DoomServerPluginContext): RootDeclaration<DoomServerSessionPlugin, DoomServerPluginContext> => {
    const value = {
      api: [api],
      ...(agent ? createPlanServerSession(agent) : {}),
    };
    return {
      value,
      services: [...(value.services ?? []), ...(value.tools?.length ? [mountMcpTools(value.tools)] : [])],
    };
  },
);
