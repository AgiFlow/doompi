import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createWorkflowsChannel } from '../../../services/workflowsHubChannel';

export default defineChannel(createWorkflowsChannel);
