import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';

import { createWorkflowsChannel } from '../../../services/workflowsHubChannel';

export default defineChannel(createWorkflowsChannel);
