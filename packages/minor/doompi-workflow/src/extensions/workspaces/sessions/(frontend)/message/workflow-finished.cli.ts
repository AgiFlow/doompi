import { defineMessageRenderer } from '@agimon-ai/doompi-core/piExtension';

import { createWorkflowFinishedRenderer } from './_lib/workflowFinishedRenderer';

export default defineMessageRenderer(...createWorkflowFinishedRenderer());
