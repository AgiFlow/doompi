import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';

import { createWorkflowCatalogChannel } from '../../../services/workflowCatalogChannel';

export default defineChannel(createWorkflowCatalogChannel);
