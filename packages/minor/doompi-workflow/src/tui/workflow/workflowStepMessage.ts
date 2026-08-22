import type { Theme } from '@earendil-works/pi-coding-agent';
import { Box, type Component, Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { StepReport } from './workflowStatusRow';

export interface WorkflowStepMessageDetails {
  displayName: string;
  duration?: string;
  job: string;
  status: StepReport['status'];
  step: string;
}

export function workflowStepMessageDetails(displayName: string, report: StepReport): WorkflowStepMessageDetails {
  return {
    displayName,
    job: report.job,
    status: report.status,
    step: report.step,
    ...(report.duration ? { duration: report.duration } : {}),
  };
}

export function formatWorkflowStepMessage(details: WorkflowStepMessageDetails): string {
  const transition = details.duration
    ? `${details.status}::${details.duration}::${details.step}`
    : `${details.status}::${details.step}`;
  return `[${details.displayName}]: ${details.job}\n${transition}`;
}

export function isWorkflowStepMessageDetails(value: unknown): value is WorkflowStepMessageDetails {
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

export function renderWorkflowStepMessage(
  details: WorkflowStepMessageDetails | undefined,
  fallback: string,
  outputPad: number,
  theme: Theme,
): Component {
  const box = new Box(outputPad, 1, (text) => theme.bg('customMessageBg', text));
  box.addChild(details ? new WorkflowStepMessageLines(details, theme) : new Text(fallback, 0, 0));
  return box;
}
