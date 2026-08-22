/**
 * Renders the `workflow-run-finished` custom message: one line per run that
 * reached a terminal state, rather than the host's default block of the
 * `[workflow-run-finished]` label above raw markdown.
 *
 * The same shape `@agimon-ai/doompi-team` gives a slash launch: a status glyph,
 * the run's identity, its outcome, and anything that went wrong indented under
 * it. A finished run is read at a glance in a transcript that is mostly about
 * something else, so it earns a line, not a card.
 *
 * DESIGN PATTERNS:
 * - A message with no `details` renders its content verbatim. That is a
 *   transcript entry written before the field existed, and re-deriving it by
 *   parsing the summary back out of markdown is exactly the liability
 *   `completionNotice.ts` in the team package refused to port
 * - The full summary is still the message's `content`, which is what the model
 *   reads and what `deliverAs: 'steer'` carries. This changes what a person
 *   sees, never what the agent is told
 */

import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { type Component, Text } from '@earendil-works/pi-tui';

export const WORKFLOW_FINISHED_MESSAGE = 'workflow-run-finished';

/** One finished run, as the extension records it on the message. */
export interface WorkflowFinishedRun {
  runKey: string;
  workspace: string;
  stage: string;
  workflowId?: string;
  failedJob?: string;
  error?: string;
}

export interface WorkflowFinishedDetails {
  /** Kept for readers that already index runs by id; the lines come from `runs`. */
  runIds?: string[];
  runs?: WorkflowFinishedRun[];
}

const COMPLETED_STAGE = 'completed';
const HELD_STAGES = new Set(['stopped', 'paused', 'cancelled']);

function statusIcon(stage: string, theme: Theme): string {
  if (stage === COMPLETED_STAGE) return theme.fg('success', '✔');
  // Held is not failed: the run went nowhere wrong, it just stopped short.
  if (HELD_STAGES.has(stage)) return theme.fg('warning', '■');
  return theme.fg('error', '✖');
}

function runLine(run: WorkflowFinishedRun, theme: Theme): string {
  const separator = ` ${theme.fg('dim', '·')} `;
  const identity = [run.runKey, run.workspace].filter(Boolean).join('/');
  const parts = [theme.fg('dim', identity), theme.fg('dim', run.stage)];
  if (run.workflowId) parts.unshift(theme.bold(run.workflowId));
  let text = `${statusIcon(run.stage, theme)} ${parts.join(separator)}`;
  if (run.failedJob) text += `\n  ${theme.fg('dim', `⎿  failed job: ${run.failedJob}`)}`;
  if (run.error) text += `\n  ${theme.fg('dim', `⎿  ${run.error}`)}`;
  return text;
}

/**
 * Exported for tests: the rendered string before it is wrapped in a `Text`
 * component, so the formatting is assertable without a terminal.
 */
export function renderWorkflowFinished(runs: readonly WorkflowFinishedRun[], theme: Theme): string {
  return runs.map((run) => runLine(run, theme)).join('\n');
}

export function isWorkflowFinishedRuns(value: unknown): value is WorkflowFinishedRun[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as WorkflowFinishedRun).runKey === 'string' &&
      typeof (entry as WorkflowFinishedRun).stage === 'string',
  );
}

export function registerWorkflowFinishedRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(WORKFLOW_FINISHED_MESSAGE, (message, _options, theme: Theme): Component => {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const runs = (message.details as WorkflowFinishedDetails | undefined)?.runs;
    if (!isWorkflowFinishedRuns(runs)) return new Text(content, 0, 0);
    return new Text(renderWorkflowFinished(runs, theme), 0, 0);
  });
}
