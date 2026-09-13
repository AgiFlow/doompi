import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { PACKAGE_SOURCE } from '../constants/workflow';
import { createWorkflowServerRuntime } from '../controllers/serverRuntime';
import { createWorkflowCatalogChannel } from '../controllers/workflowCatalogChannel';
import { api } from '../controllers/workflowHubApi';
import { createWorkflowsChannel } from '../controllers/workflowsHubChannel';
export const workflowServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  global: { channels: [createWorkflowsChannel, createWorkflowCatalogChannel], api: [api] },
  workspace: { channels: [createWorkflowsChannel, createWorkflowCatalogChannel], api: [api] },
  session: ({ agent, host }) => ({ api: [api], ...(agent ? createWorkflowServerRuntime(agent, host) : {}) }),
});
export default workflowServerFacet;
