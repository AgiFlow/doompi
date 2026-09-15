import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createWorkflowCatalogChannel } from '../../controllers/workflowCatalogChannel';
import { api } from '../../controllers/workflowHubApi';
import { createWorkflowsChannel } from '../../controllers/workflowsHubChannel';

export default (({ host }) =>
  host.scope === 'session'
    ? {}
    : { channels: [createWorkflowsChannel, createWorkflowCatalogChannel], api: [api] }) satisfies NonNullable<
  DoomServerPluginDefinition['global']
>;
