import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/serverFacet';

import { createWorkflowServerRuntime } from '../../../../../services/serverRuntime';
import { api } from '../../../../../services/workflowHubApi';

// A session with an agent mounts the API with its runtime, which can launch into this session.
export default (({ agent, host }) =>
  agent ? createWorkflowServerRuntime(agent, host) : { api: [api] }) satisfies NonNullable<
  DoomServerPluginDefinition['session']
>;
