import { defineMessageRenderer } from '@agimon-ai/doompi-core/pi-extension';

import { createWorkflowFinishedRenderer } from '../../../../../tui/workflow/workflowFinishedMessage';

export default defineMessageRenderer(...createWorkflowFinishedRenderer());
