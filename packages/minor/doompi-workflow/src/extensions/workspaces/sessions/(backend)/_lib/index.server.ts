import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createWorkflowServerRuntime } from '../../../../../services/serverRuntime';
import { api } from '../../../../../services/workflowHubApi';

export default (({ agent, host }) => ({
  api: [api],
  ...(agent ? createWorkflowServerRuntime(agent, host) : {}),
})) satisfies NonNullable<DoomServerPluginDefinition['session']>;
