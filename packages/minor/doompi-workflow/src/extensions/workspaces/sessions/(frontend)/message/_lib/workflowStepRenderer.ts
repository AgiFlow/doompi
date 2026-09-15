import type { PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';

import {
  isWorkflowStepMessageDetails,
  renderWorkflowStepMessage,
} from '../../../../../../tui/workflow/workflowStepMessage';

export const LEGACY_WORKFLOW_STEP_MESSAGE = 'workflow-step';

export const workflowStepRenderer: NonNullable<PiPluginContributions['messageRenderers']>[number][1] = (
  message,
  { outputPad },
  theme,
) => {
  const details = isWorkflowStepMessageDetails(message.details) ? message.details : undefined;
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return renderWorkflowStepMessage(details, content, outputPad, theme);
};
