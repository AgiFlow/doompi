import { defineMessageRenderer } from '@agimon-ai/doompi-core/pi-extension';

import { createWorkflowFinishedRenderer } from './_lib/workflowFinishedRenderer';

export default defineMessageRenderer(...createWorkflowFinishedRenderer());
