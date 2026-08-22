import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatWorkflowDuration,
  formatWorkflowProgressRow,
  WORKFLOW_PROGRESS_COLORS,
  WORKFLOW_PROGRESS_WIDGET_KEY,
  WorkflowProgressOverlay,
  type WorkflowProgressRow,
  type WorkflowProgressState,
  workflowProgressRow,
} from '../../src/tui/workflow/workflowProgressOverlay';

function createTheme(calls?: Array<{ color: string; text: string }>): Theme {
  return {
    fg: (color: string, text: string) => {
      calls?.push({ color, text });
      return text;
    },
  } as unknown as Theme;
}

function runRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    displayName: 'Auth workflow',
    dryRun: false,
    runId: '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
    runKey: 'auth-run',
    stage: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    workflowPath: '/repo/automations/auth.workflow.yml',
    workspace: 'agiflow',
    ...overrides,
  };
}

function progressRow(overrides: Partial<WorkflowProgressRow> = {}): WorkflowProgressRow {
  return {
    job: 'verify',
    key: 'run-1',
    name: 'Auth workflow',
    startedAt: '2026-01-01T00:00:00.000Z',
    state: 'running',
    step: 'Claim the job',
    ...overrides,
  };
}

describe('workflow progress row', () => {
  it('derives the current workflow name, job, step, and state', () => {
    const events: WorkflowProgressEvent[] = [
      {
        at: '2026-01-01T00:00:01.000Z',
        job: 'verify',
        status: 'running',
        type: 'job',
      },
      {
        at: '2026-01-01T00:00:02.000Z',
        job: 'verify',
        status: 'running',
        step: 'Claim the job',
        type: 'step',
      },
    ];

    expect(workflowProgressRow(runRecord(), events)).toEqual({
      job: 'verify',
      key: '7c2eb3d5-c8a3-4f45-b1ab-b9d57f7b986f',
      name: 'Auth workflow',
      startedAt: '2026-01-01T00:00:00.000Z',
      state: 'running',
      step: 'Claim the job',
    });
  });

  it('uses the execution cursor and paused state when the progress log has no current step', () => {
    const record = runRecord({
      executionCursor: {
        executionGeneration: 1,
        job: 'build',
        phase: 'step',
        resumeMode: 'replay-current',
        stepName: 'Compile packages',
      },
      executionState: 'paused',
    });

    expect(workflowProgressRow(record, [])).toMatchObject({
      job: 'build',
      state: 'paused',
      step: 'Compile packages',
    });
  });

  it('defines a distinct theme color for every progress state', () => {
    const states: WorkflowProgressState[] = ['starting', 'running', 'completed', 'paused', 'failed', 'skipped'];
    expect(new Set(states.map((state) => WORKFLOW_PROGRESS_COLORS[state])).size).toBe(states.length);
  });

  it('renders the requested line shape and colors the workflow name by state', () => {
    const calls: Array<{ color: string; text: string }> = [];
    const line = formatWorkflowProgressRow(
      progressRow({ state: 'paused' }),
      createTheme(calls),
      Date.parse('2026-01-01T00:01:02.000Z'),
    );

    expect(line).toBe('Auth workflow[1m02s][verify] * Claim the job');
    expect(calls).toContainEqual({ color: 'warning', text: 'Auth workflow' });
    expect(calls).toContainEqual({ color: 'muted', text: '[1m02s][verify]' });
  });

  it('animates running activity without replacing the structured step status', () => {
    const row = progressRow({ startedAt: '1970-01-01T00:00:00.000Z' });

    expect(formatWorkflowProgressRow(row, createTheme(), 0)).toBe('Auth workflow[0s][verify] ⠋ Claim the job');
    expect(formatWorkflowProgressRow(row, createTheme(), 200)).toBe('Auth workflow[0s][verify] ⠙ Claim the job');
  });

  it('formats duration boundaries deterministically', () => {
    expect(formatWorkflowDuration(0)).toBe('0s');
    expect(formatWorkflowDuration(59_999)).toBe('59s');
    expect(formatWorkflowDuration(60_000)).toBe('1m00s');
    expect(formatWorkflowDuration(3_723_000)).toBe('1h02m03s');
    expect(formatWorkflowDuration(Number.NaN)).toBe('?');
  });
});

describe('WorkflowProgressOverlay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(rows: WorkflowProgressRow[]) {
    const setWidget = vi.fn();
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const context = { setWidget, theme: createTheme() } as unknown as ExtensionUIContext;
    const overlay = new WorkflowProgressOverlay();
    overlay.setUICtx(context);
    overlay.update(rows);
    const factory = setWidget.mock.calls[0]?.[1];
    if (typeof factory !== 'function') throw new Error('Expected a workflow widget factory');
    const component = factory(tui, createTheme());
    return { component, context, overlay, setWidget, tui };
  }

  it('renders a task-like heading and tree above the editor', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-01-01T00:01:02.000Z');
    const harness = setup([progressRow()]);

    expect(harness.setWidget).toHaveBeenCalledWith(WORKFLOW_PROGRESS_WIDGET_KEY, expect.any(Function), {
      placement: 'aboveEditor',
    });
    expect(harness.component.render(80)).toEqual([
      '● Workflows (1)',
      '└─ Auth workflow[1m02s][verify] ⠋ Claim the job',
      '',
    ]);
    harness.overlay.dispose();
  });

  it('repaints an existing widget instead of registering another one', () => {
    vi.useFakeTimers();
    const harness = setup([progressRow()]);

    harness.overlay.update([progressRow({ step: 'Run tests' })]);

    expect(harness.setWidget).toHaveBeenCalledTimes(1);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(1);
    expect(harness.component.render(80).join('\n')).toContain('Run tests');
    harness.overlay.dispose();
  });

  it('ticks only while workflows are visible and removes the widget when they finish', () => {
    vi.useFakeTimers();
    const harness = setup([progressRow()]);

    vi.advanceTimersByTime(3000);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(15);

    harness.overlay.update([]);
    vi.advanceTimersByTime(2000);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(15);
    expect(harness.setWidget).toHaveBeenLastCalledWith(WORKFLOW_PROGRESS_WIDGET_KEY, undefined);
    harness.overlay.dispose();
  });

  it('truncates every rendered line to the terminal width', () => {
    vi.useFakeTimers();
    const harness = setup([
      progressRow({ name: 'A very long workflow display name', step: 'A step that is also much too long' }),
    ]);

    for (const line of harness.component.render(28)) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
    harness.overlay.dispose();
  });
});
