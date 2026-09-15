import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createWorkflowCatalogChannel } from '../../services/workflowCatalogChannel';
import { api } from '../../services/workflowHubApi';
import { createWorkflowsChannel } from '../../services/workflowsHubChannel';

export default (({ host }) =>
  host.scope === 'session'
    ? {}
    : { channels: [createWorkflowsChannel, createWorkflowCatalogChannel], api: [api] }) satisfies NonNullable<
  DoomServerPluginDefinition['global']
>;
