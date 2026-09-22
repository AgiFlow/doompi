import { defineMessageRenderer } from '@agimon-ai/doompi-core/piExtension';

import { LEGACY_WORKFLOW_STEP_MESSAGE, workflowStepRenderer } from './_lib/workflowStepRenderer';

export default defineMessageRenderer(LEGACY_WORKFLOW_STEP_MESSAGE, workflowStepRenderer);
