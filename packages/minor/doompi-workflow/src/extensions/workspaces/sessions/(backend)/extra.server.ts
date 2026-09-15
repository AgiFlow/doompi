import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createWorkflowServerRuntime } from '../../../../controllers/serverRuntime';
import { api } from '../../../../controllers/workflowHubApi';

export default (({ agent, host }) => ({
  api: [api],
  ...(agent ? createWorkflowServerRuntime(agent, host) : {}),
})) satisfies NonNullable<DoomServerPluginDefinition['session']>;
