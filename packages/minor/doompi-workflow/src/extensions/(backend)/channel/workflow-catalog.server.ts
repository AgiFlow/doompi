import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createWorkflowCatalogChannel } from '../../../services/workflowCatalogChannel';

export default defineChannel(createWorkflowCatalogChannel);
