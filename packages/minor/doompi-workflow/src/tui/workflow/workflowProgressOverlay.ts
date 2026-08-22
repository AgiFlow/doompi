/**
 * Task-like live workflow list shown above Pi's editor.
 *
 * DESIGN PATTERNS:
 * - The extension owns run/event state; this component only projects and renders it.
 * - Register the widget once, then request redraws as progress, elapsed time, or the spinner changes.
 * - Terminal runs are absent from `rows`, so the widget disappears when the last run ends.
 *
 * CODING STANDARDS:
 * - Every rendered line is ANSI-aware and truncated to the available terminal width.
 * - Theme colors come from Pi's live UI context so theme changes repaint correctly.
 * - Named exports only and explicit return types on exported members.
 *
 * AVOID:
 * - Persisting progress in the chat transcript.
 * - Starting timers while no workflow is visible.
 */

import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, truncateToWidth } from '@earendil-works/pi-tui';

export const WORKFLOW_PROGRESS_WIDGET_KEY = 'workflow-mcp-progress';

const OVERLAY_HEADING = 'Workflows';
const PROGRESS_TICK_MS = 200;
const RUNNING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const STATIC_PROGRESS_MARKER = '*';
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const STARTING_JOB_STEP = 'Starting job';
const STARTING_WORKFLOW_STEP = 'Starting workflow';
const PREPARING_WORKFLOW_STEP = 'Preparing workflow';
const FINALIZING_WORKFLOW_STEP = 'Finalizing workflow';

type WorkflowProgressColor = Parameters<Theme['fg']>[0];

export type WorkflowProgressState = 'completed' | 'failed' | 'paused' | 'running' | 'skipped' | 'starting';

/** One explicit palette makes every workflow state visually stable across the list. */
export const WORKFLOW_PROGRESS_COLORS: Readonly<Record<WorkflowProgressState, WorkflowProgressColor>> = {
  starting: 'dim',
  running: 'accent',
  completed: 'success',
  paused: 'warning',
  failed: 'error',
  skipped: 'muted',
};

export interface WorkflowProgressRow {
  job: string;
  key: string;
  name: string;
  startedAt: string;
  state: WorkflowProgressState;
  step: string;
}

function latestStep(events: readonly WorkflowProgressEvent[]): WorkflowProgressEvent | undefined {
  return events.findLast((event) => event.type === 'step' && !!event.step);
}

function latestEvent(events: readonly WorkflowProgressEvent[]): WorkflowProgressEvent | undefined {
  return events.at(-1);
}

function progressState(record: WorkflowRunRecord, event: WorkflowProgressEvent | undefined): WorkflowProgressState {
  if (record.stage === 'error') return 'failed';
  if (record.stage === 'completed') return 'completed';
  if (record.executionState === 'paused' || record.executionState === 'pause_requested') return 'paused';

  switch (event?.status) {
    case 'failed':
      return 'failed';
    case 'paused':
    case 'pause_requested':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'skipped':
      return 'skipped';
    case 'resumed':
    case 'running':
      return 'running';
    default:
      return record.executionCursor?.stepName ? 'running' : 'starting';
  }
}

function fallbackStep(record: WorkflowRunRecord): string {
  switch (record.executionCursor?.phase) {
    case 'pre':
      return PREPARING_WORKFLOW_STEP;
    case 'post':
      return FINALIZING_WORKFLOW_STEP;
    case 'job':
    case 'step':
      return STARTING_JOB_STEP;
    default:
      return STARTING_WORKFLOW_STEP;
  }
}

/** Derive the single current line for one run from its record and pushed progress events. */
export function workflowProgressRow(
  record: WorkflowRunRecord,
  events: readonly WorkflowProgressEvent[],
): WorkflowProgressRow {
  const stepEvent = latestStep(events);
  const event = latestEvent(events);
  const cursor = record.executionCursor;
  const job = cursor?.job ?? stepEvent?.job ?? event?.job ?? record.job ?? cursor?.phase ?? 'workflow';
  const step = cursor?.stepName ?? (stepEvent?.job === job ? stepEvent.step : undefined) ?? fallbackStep(record);

  return {
    job,
    key: record.runId ?? `${record.workspace}/${record.runKey}`,
    name: record.displayName,
    startedAt: record.startedAt,
    state: progressState(record, event),
    step,
  };
}

/** Task-style elapsed time: whole seconds stay stable and compact between animation ticks. */
export function formatWorkflowDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '?';
  const totalSeconds = Math.floor(durationMs / MILLISECONDS_PER_SECOND);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) {
    return totalMinutes === 0 ? `${seconds}s` : `${totalMinutes}m${String(seconds).padStart(2, '0')}s`;
  }
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
}

function progressMarker(state: WorkflowProgressState, nowMs: number): string {
  if (state !== 'running' && state !== 'starting') return STATIC_PROGRESS_MARKER;
  const tick = Number.isFinite(nowMs) ? Math.floor(Math.max(0, nowMs) / PROGRESS_TICK_MS) : 0;
  return RUNNING_SPINNER_FRAMES[tick % RUNNING_SPINNER_FRAMES.length] ?? RUNNING_SPINNER_FRAMES[0];
}

/** Render exactly: `<workflow name>[<duration>][<job>] <activity> <step>`. */
export function formatWorkflowProgressRow(row: WorkflowProgressRow, theme: Theme, nowMs = Date.now()): string {
  const startedAt = Date.parse(row.startedAt);
  const duration = formatWorkflowDuration(Number.isFinite(startedAt) ? nowMs - startedAt : Number.NaN);
  const color = WORKFLOW_PROGRESS_COLORS[row.state];
  return [
    theme.fg(color, row.name),
    theme.fg('muted', `[${duration}][${row.job}]`),
    theme.fg(color, ` ${progressMarker(row.state, nowMs)} `),
    theme.fg('text', row.step),
  ].join('');
}

/** Persistent workflow widget with the same heading/tree shape as Doom's task list. */
export class WorkflowProgressOverlay {
  private rows: readonly WorkflowProgressRow[] = [];
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private progressTimer: NodeJS.Timeout | undefined;

  /** Identity-compare so repeated session starts do not register duplicate widgets. */
  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx === this.uiCtx) return;
    if (this.uiCtx && this.widgetRegistered) this.uiCtx.setWidget(WORKFLOW_PROGRESS_WIDGET_KEY, undefined);
    this.stopProgressTimer();
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
  }

  update(rows: readonly WorkflowProgressRow[]): void {
    this.rows = rows;
    if (!this.uiCtx) {
      this.stopProgressTimer();
      return;
    }

    if (rows.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WORKFLOW_PROGRESS_WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      this.stopProgressTimer();
      return;
    }

    if (this.widgetRegistered) {
      this.syncProgressTimer();
      this.tui?.requestRender();
      return;
    }

    this.uiCtx.setWidget(
      WORKFLOW_PROGRESS_WIDGET_KEY,
      (tui, factoryTheme) => {
        this.tui = tui;
        return {
          render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
          invalidate: () => {
            // Nothing cached: the next render reads the current rows, clock, and theme.
          },
        };
      },
      { placement: 'aboveEditor' },
    );
    this.widgetRegistered = true;
    this.syncProgressTimer();
  }

  private syncProgressTimer(): void {
    if (!this.widgetRegistered || this.rows.length === 0) {
      this.stopProgressTimer();
      return;
    }
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => this.tui?.requestRender(), PROGRESS_TICK_MS);
    this.progressTimer.unref?.();
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    if (this.rows.length === 0) return [];
    const truncate = (line: string): string => truncateToWidth(line, width, '…');
    const heading = truncate(
      `${theme.fg('accent', '●')} ${theme.fg('accent', `${OVERLAY_HEADING} (${this.rows.length})`)}`,
    );
    const nowMs = Date.now();
    const lines = [heading];

    for (const [index, row] of this.rows.entries()) {
      const branch = index === this.rows.length - 1 ? '└─' : '├─';
      lines.push(truncate(`${theme.fg('dim', branch)} ${formatWorkflowProgressRow(row, theme, nowMs)}`));
    }

    // Pi adds space above widgets but not below; keep the list off the editor border.
    lines.push('');
    return lines;
  }

  dispose(): void {
    this.stopProgressTimer();
    if (this.uiCtx) this.uiCtx.setWidget(WORKFLOW_PROGRESS_WIDGET_KEY, undefined);
    this.rows = [];
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}
