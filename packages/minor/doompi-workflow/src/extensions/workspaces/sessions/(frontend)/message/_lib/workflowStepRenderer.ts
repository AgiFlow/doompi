import type { PiPluginContributions } from '@agimon-ai/doompi-core/piExtension';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { Box, type Component, Text, truncateToWidth } from '@earendil-works/pi-tui';

export const LEGACY_WORKFLOW_STEP_MESSAGE = 'workflow-step';

interface WorkflowStepMessageDetails {
  displayName: string;
  duration?: string;
  job: string;
  status: 'STARTED' | 'FINISHED' | 'FAILED';
  step: string;
}

function isWorkflowStepMessageDetails(value: unknown): value is WorkflowStepMessageDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkflowStepMessageDetails>;
  return (
    typeof candidate.displayName === 'string' &&
    typeof candidate.job === 'string' &&
    typeof candidate.step === 'string' &&
    (candidate.status === 'STARTED' || candidate.status === 'FINISHED' || candidate.status === 'FAILED') &&
    (candidate.duration === undefined || typeof candidate.duration === 'string')
  );
}

class WorkflowStepMessageLines implements Component {
  constructor(
    private readonly details: WorkflowStepMessageDetails,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const header = `${this.theme.fg('accent', `[${this.details.displayName}]:`)} ${this.details.job}`;
    const transition = this.details.duration
      ? `${this.details.status}::${this.details.duration}::${this.details.step}`
      : `${this.details.status}::${this.details.step}`;
    const colour =
      this.details.status === 'FAILED' ? 'error' : this.details.status === 'FINISHED' ? 'success' : 'accent';
    return [truncateToWidth(header, width), truncateToWidth(this.theme.fg(colour, transition), width)];
  }

  invalidate(): void {}
}

function renderWorkflowStepMessage(
  details: WorkflowStepMessageDetails | undefined,
  fallback: string,
  outputPad: number,
  theme: Theme,
): Component {
  const box = new Box(outputPad, 1, (text) => theme.bg('customMessageBg', text));
  box.addChild(details ? new WorkflowStepMessageLines(details, theme) : new Text(fallback, 0, 0));
  return box;
}

export const workflowStepRenderer: NonNullable<PiPluginContributions['messageRenderers']>[number][1] = (
  message,
  { outputPad },
  theme,
) => {
  const details = isWorkflowStepMessageDetails(message.details) ? message.details : undefined;
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return renderWorkflowStepMessage(details, content, outputPad, theme);
};
