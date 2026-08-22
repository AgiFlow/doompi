import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/exports/store/types';
import {
  formatCommandTaskLine,
  formatElapsedMs,
  formatOverlayTaskLine,
  formatTokenCount,
  JustifiedRows,
  renderTaskCall,
  renderTaskResult,
  STATUS_GLYPH,
  STATUS_LABEL,
} from '../src/tui/format.ts';
import {
  deriveTaskProjection,
  groupTasks,
  hasActiveWork,
  selectOverlayLayout,
  shouldShowIds,
} from '../src/tui/selectors.ts';
import { TaskOverlay } from '../src/tui/taskOverlay.ts';

/** Pass-through theme so assertions read plain text, not colour codes. */
function createTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_colour: string, text: string) => text,
    bold: identity,
    inverse: identity,
    dim: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  } as unknown as Theme;
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: 1, subject: 'a task', status: 'pending', ...overrides };
}

describe('formatOverlayTaskLine', () => {
  it('shows the delegated agent and its current tool while a run is live', () => {
    const live = task({
      status: 'in_progress',
      activeForm: 'writing tests',
      delegation: { requestId: 'r', agent: 'impl', state: 'running' },
    });

    const line = formatOverlayTaskLine(
      live,
      createTheme(),
      true,
      { agent: 'impl', currentTool: 'Edit', tokens: 3400, durationMs: 62_000, durationObservedAt: 1_000 },
      1_000,
    );

    expect(line).toContain('#1');
    expect(line).toContain('[1m02s][3.4k][impl] · Edit');
    expect(line).toContain('writing tests');
    expect(line).not.toContain('⟳');
  });

  it('omits unavailable tokens but renders observed zero', () => {
    const live = task({ delegation: { requestId: 'r', agent: 'impl', state: 'running' } });

    expect(formatOverlayTaskLine(live, createTheme(), false, { agent: 'impl' }, 0)).toContain('[0s][impl]');
    expect(formatOverlayTaskLine(live, createTheme(), false, { agent: 'impl', tokens: 0 }, 0)).toContain(
      '[0s][0][impl]',
    );
  });

  it('formats elapsed and token boundaries deterministically', () => {
    expect(formatElapsedMs(0)).toBe('0s');
    expect(formatElapsedMs(59_999)).toBe('59s');
    expect(formatElapsedMs(60_000)).toBe('1m00s');
    expect(formatElapsedMs(62_000)).toBe('1m02s');
    expect(formatElapsedMs(3_723_000)).toBe('1h02m03s');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(9999)).toBe('10.0k');
    expect(formatTokenCount(10_001)).toBe('10k');
  });

  it('uses the stable run instance color and keeps chips and tool activity muted', () => {
    const colors: Array<{ color: string; text: string }> = [];
    const themed = createTheme();
    themed.fg = (color: string, text: string) => {
      colors.push({ color, text });
      return text;
    };
    const live = task({
      status: 'in_progress',
      delegation: { requestId: 'r', runId: 'run-a', agent: 'researcher', state: 'running' },
    });

    formatOverlayTaskLine(
      live,
      themed,
      false,
      { agent: 'researcher', currentTool: 'Read', tokens: 1200, durationMs: 1000, durationObservedAt: 1000 },
      1000,
    );

    expect(colors).toContainEqual({ color: agentIdentityColor('run-a'), text: '[researcher]' });
    expect(colors).toContainEqual({ color: 'muted', text: '[1s]' });
    expect(colors).toContainEqual({ color: 'muted', text: '[1.2k]' });
    expect(colors).toContainEqual({ color: 'muted', text: '· Read' });
  });

  it('shows a finished delegation as a plain badge and lists blockers', () => {
    const finished = task({ blockedBy: [2, 3], delegation: { requestId: 'r', agent: 'impl', state: 'completed' } });

    const line = formatOverlayTaskLine(finished, createTheme(), false, undefined);

    expect(line).toContain('[impl]');
    expect(line).toContain('#2,#3');
    expect(line).not.toContain('⟳');
  });

  it('strikes through a completed subject', () => {
    const struck: string[] = [];
    const theme = createTheme();
    theme.strikethrough = (text: string) => {
      struck.push(text);
      return text;
    };

    formatOverlayTaskLine(task({ status: 'completed' }), theme, false, undefined);

    expect(struck).toContain('a task');
  });
});

describe('TaskOverlay ticker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function activeTask(): Task {
    return task({
      status: 'in_progress',
      delegation: { requestId: 'request-1', agent: 'impl', state: 'running' },
    });
  }

  function setup(tasks: Task[], currentTool?: string) {
    const setWidget = vi.fn();
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const context = { setWidget, theme: createTheme() } as unknown as ExtensionUIContext;
    const overlay = new TaskOverlay({
      getTasks: () => tasks,
      delegation: {
        progressFor: () => (currentTool === undefined ? undefined : { agent: 'impl', currentTool }),
      } as never,
    });
    overlay.setUICtx(context);
    overlay.update();
    const factory = setWidget.mock.calls[0]?.[1];
    if (typeof factory !== 'function') throw new Error('Expected a widget factory');
    const widget = factory(tui, createTheme()) as { render(width: number): string[] };
    return { overlay, setWidget, tui, widget };
  }

  it('keeps multiline task activity inside one physical widget row', () => {
    const live = activeTask();
    live.subject = 'audit\nexports';
    live.activeForm = 'running\nchecks';
    live.delegation = { ...live.delegation!, agent: 'impl\nagent' };
    const harness = setup([live], "bash (python3 - <<'PY'\nfrom pathlib import Path\nPY)");

    const lines = harness.widget.render(240);
    const rendered = lines.join(' ');

    expect(lines.every((line) => !line.includes('\n') && !line.includes('\r'))).toBe(true);
    expect(rendered).toContain('audit exports');
    expect(rendered).toContain('[impl agent]');
    expect(rendered).toContain("bash (python3 - <<'PY' from pathlib import Path PY)");
    expect(rendered).toContain('(running checks)');
    harness.overlay.dispose();
  });

  it('starts one active-only timer and requests redraws without store updates', () => {
    vi.useFakeTimers();
    const harness = setup([activeTask()]);

    vi.advanceTimersByTime(3000);

    expect(harness.tui.requestRender).toHaveBeenCalledTimes(3);
    expect(harness.setWidget).toHaveBeenCalledTimes(1);
    harness.overlay.dispose();
  });

  it('stops the timer when delegation completes or the task is removed', () => {
    vi.useFakeTimers();
    const tasks = [activeTask()];
    const harness = setup(tasks);

    vi.advanceTimersByTime(1000);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(1);

    tasks[0] = { ...tasks[0]!, delegation: { ...tasks[0]!.delegation!, state: 'completed' } };
    harness.overlay.update();
    vi.advanceTimersByTime(2000);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(2);

    tasks.splice(0, 1);
    harness.overlay.update();
    vi.advanceTimersByTime(2000);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(2);
    expect(harness.setWidget).toHaveBeenLastCalledWith('doom-tasks', undefined);
    harness.overlay.dispose();
  });

  it('pauses invisible ticks while collapsed and restarts them when expanded', () => {
    vi.useFakeTimers();
    const harness = setup([activeTask()]);

    harness.overlay.toggleCollapse();
    vi.mocked(harness.tui.requestRender).mockClear();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(harness.tui.requestRender).not.toHaveBeenCalled();

    harness.overlay.toggleCollapse();
    vi.mocked(harness.tui.requestRender).mockClear();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(2);
    harness.overlay.dispose();
  });

  it('unregisters the old widget and timer when the UI context changes', () => {
    vi.useFakeTimers();
    const tasks = [activeTask()];
    const harness = setup(tasks);
    const replacement = { setWidget: vi.fn(), theme: createTheme() } as unknown as ExtensionUIContext;

    harness.overlay.setUICtx(replacement);
    vi.advanceTimersByTime(2000);

    expect(harness.setWidget).toHaveBeenLastCalledWith('doom-tasks', undefined);
    expect(harness.tui.requestRender).not.toHaveBeenCalled();
    harness.overlay.dispose();
  });

  it('cleans up the timer and widget on dispose', () => {
    vi.useFakeTimers();
    const harness = setup([activeTask()]);

    harness.overlay.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);

    expect(harness.tui.requestRender).not.toHaveBeenCalled();
    expect(harness.setWidget).toHaveBeenLastCalledWith('doom-tasks', undefined);
  });
});

describe('formatCommandTaskLine', () => {
  it('carries the glyph, id, agent and blockers', () => {
    const entry = task({
      status: 'in_progress',
      activeForm: 'shipping',
      blockedBy: [2],
      delegation: { requestId: 'r', agent: 'impl', state: 'running' },
    });

    const line = formatCommandTaskLine(entry, STATUS_GLYPH.in_progress);

    expect(line).toContain('#1 a task (shipping) [impl]');
    expect(line).toContain('#2');
  });
});

describe('renderTaskCall', () => {
  const tasks = [task({ id: 1, subject: 'existing' })];

  it('uses a Doom tool badge with an action purpose and horizontal inset', () => {
    const [line] = renderTaskCall({ action: 'list' }, createTheme(), tasks).render(80);

    expect(line?.trimEnd()).toBe('  TASK  ☰ list');
  });

  it.each([
    ['assign' as const, { assignments: [{ id: 1, agent: 'impl' }] }, 'impl'],
    ['list' as const, { status: 'failed' as const }, STATUS_LABEL.failed],
  ])('renders the %s call', (action, params, expected) => {
    const text = renderTaskCall({ action, ...params }, createTheme(), tasks);

    expect(JSON.stringify(text)).toContain(expected);
  });

  it('renders a single new-task upsert with its own subject', () => {
    const text = renderTaskCall({ action: 'upsert', tasks: [{ subject: 'brand new' }] }, createTheme(), tasks);

    expect(JSON.stringify(text)).toContain('brand new');
  });

  it('renders a single existing-task upsert with the stored subject', () => {
    const text = renderTaskCall({ action: 'upsert', tasks: [{ id: 1 }] }, createTheme(), tasks);

    expect(JSON.stringify(text)).toContain('existing');
  });

  it('renders a multi-entry upsert as a count', () => {
    const args = { action: 'upsert' as const, tasks: [{ subject: 'a' }, { subject: 'b' }, { id: 1 }] };

    expect(JSON.stringify(renderTaskCall(args, createTheme(), tasks))).toContain('3 tasks');
  });

  it('renders a native assignment batch as one counted call', () => {
    const args = {
      action: 'assign' as const,
      assignments: [
        { id: 1, agent: 'architect' },
        { id: 2, agent: 'reviewer' },
        { id: 3, agent: 'experience' },
      ],
    };

    expect(JSON.stringify(renderTaskCall(args, createTheme(), tasks))).toContain('3 tasks');
  });

  it('narrows the glyph to what a homogeneous batch actually did', () => {
    const theme = createTheme();
    const creates = { action: 'upsert' as const, tasks: [{ subject: 'a' }, { subject: 'b' }] };
    const updates = { action: 'upsert' as const, tasks: [{ id: 1 }, { id: 1, status: 'failed' as const }] };
    const mixed = { action: 'upsert' as const, tasks: [{ subject: 'a' }, { id: 1 }] };

    expect(JSON.stringify(renderTaskCall(creates, theme, tasks))).toContain('+');
    expect(JSON.stringify(renderTaskCall(updates, theme, tasks))).toContain('→');
    expect(JSON.stringify(renderTaskCall(mixed, theme, tasks))).toContain('✎');
  });

  it('falls back to the id when the task is unknown', () => {
    const text = renderTaskCall({ action: 'get', id: 99 }, createTheme(), tasks);

    expect(JSON.stringify(text)).toContain('#99');
  });
});

describe('JustifiedRows', () => {
  it('flushes the trailing text to the right edge', () => {
    const [line] = new JustifiedRows([{ left: 'subject', right: 'pending' }]).render(30);

    expect(visibleWidth(line ?? '')).toBe(30);
    expect(line?.startsWith('subject')).toBe(true);
    expect(line?.endsWith('pending')).toBe(true);
  });

  it('truncates the subject rather than dropping the status', () => {
    const [line] = new JustifiedRows([{ left: 'a very long task subject indeed', right: 'in progress' }]).render(20);

    expect(visibleWidth(line ?? '')).toBe(20);
    expect(line?.endsWith('in progress')).toBe(true);
  });

  it('keeps a row without trailing text unpadded', () => {
    expect(new JustifiedRows([{ left: 'plain' }]).render(30)).toEqual(['plain']);
  });

  it('drops the status when the row is too narrow to hold both', () => {
    const [line] = new JustifiedRows([{ left: 'subject', right: 'in progress' }]).render(6);

    expect(visibleWidth(line ?? '')).toBe(6);
    expect(line).not.toContain('in progress');
  });
});

describe('renderTaskResult', () => {
  const settled = { expanded: false, isPartial: false };
  const WIDE = 300;

  /** Remove the self-owned shell when an assertion targets result content. */
  function lines(text: { render(width: number): string[] }): string[] {
    const rendered = text
      .render(WIDE)
      .map((line) => line.trimEnd())
      .map((line) => (line.startsWith(' ') ? line.slice(1) : line));
    if (/^─+$/.test(rendered[0] ?? '')) rendered.shift();
    while (rendered.at(-1) === '') rendered.pop();
    return rendered;
  }

  it('uses the bash-style neutral divider for every lifecycle state', () => {
    const theme = createTheme();
    theme.fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
    const pending = renderTaskResult(
      { content: [{ type: 'text', text: 'working' }] },
      { expanded: false, isPartial: true },
      theme,
    ).render(20);
    const success = renderTaskResult(
      { details: { action: 'list', params: {}, tasks: [], nextId: 1, rev: 1 } },
      settled,
      theme,
    ).render(20);
    const failure = renderTaskResult(
      { content: [{ type: 'text', text: 'nope' }], isError: true },
      settled,
      theme,
    ).render(20);

    expect(pending[0]).toContain('<borderMuted>');
    expect(success[0]).toContain('<borderMuted>');
    expect(failure[0]).toContain('<borderMuted>');
    expect(pending.at(-1)).toBe('');
    expect(success.at(-1)).toBe('');
    expect(failure.at(-1)).toBe('');
  });

  it('reports an error result', () => {
    const details = { action: 'upsert' as const, params: {}, tasks: [], nextId: 1, rev: 1, error: 'nope' };

    expect(lines(renderTaskResult({ details }, settled, createTheme()))).toEqual(['✗ nope']);
  });

  it('reports a thrown failure, which arrives with no details at all', () => {
    const result = { content: [{ type: 'text', text: 'Error: unknown task #9' }], isError: true };

    expect(lines(renderTaskResult(result, settled, createTheme()))).toEqual(['✗ Error: unknown task #9']);
  });

  it('reports the resulting status of a mutation', () => {
    const details = {
      action: 'upsert' as const,
      params: { tasks: [{ id: 1 }] },
      tasks: [task({ status: 'completed' })],
      nextId: 2,
      rev: 1,
      upsert: { applied: [1], failed: 0 },
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));

    expect(rendered.at(-1)).toContain(STATUS_LABEL.completed);
    expect(rendered[0]).toContain('a task');
  });

  it('reports a plain success for a read-only action', () => {
    const details = { action: 'list' as const, params: {}, tasks: [], nextId: 1, rev: 1 };

    expect(lines(renderTaskResult({ details }, settled, createTheme()))).toEqual(['✓ no tasks']);
  });

  it('lists the tasks instead of a bare tick', () => {
    const details = {
      action: 'list' as const,
      params: {},
      tasks: [task({ id: 3, subject: 'wire up auth guard' }), task({ id: 4, subject: 'fix token refresh' })],
      nextId: 5,
      rev: 1,
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));

    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain('wire up auth guard');
    expect(rendered[1]).toContain('fix token refresh');
    expect(rendered.at(-1)).toBe('✓ 2 tasks');
  });

  it('re-applies the list filters so the block agrees with the model text', () => {
    const details = {
      action: 'list' as const,
      params: { status: 'pending' as const },
      tasks: [task({ id: 1, status: 'pending' }), task({ id: 2, status: 'completed', subject: 'done one' })],
      nextId: 3,
      rev: 1,
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));

    expect(rendered.at(-1)).toBe('✓ 1 task');
    expect(rendered.join('\n')).not.toContain('done one');
  });

  it('hides deleted tasks unless includeDeleted was asked for', () => {
    const tasks = [task({ id: 1 }), task({ id: 2, status: 'deleted', subject: 'gone' })];
    const base = { action: 'list' as const, tasks, nextId: 3, rev: 1 };

    expect(
      lines(renderTaskResult({ details: { ...base, params: {} } }, settled, createTheme())).join('\n'),
    ).not.toContain('gone');
    expect(
      lines(renderTaskResult({ details: { ...base, params: { includeDeleted: true } } }, settled, createTheme())).join(
        '\n',
      ),
    ).toContain('gone');
  });

  it('bounds a long list when collapsed and offers the expand hint', () => {
    const tasks = Array.from({ length: 20 }, (_, index) => task({ id: index + 1, subject: `task ${index}` }));
    const details = { action: 'list' as const, params: {}, tasks, nextId: 21, rev: 1 };

    const collapsed = lines(renderTaskResult({ details }, settled, createTheme()));
    expect(collapsed).toHaveLength(9);
    expect(collapsed.at(-1)).toBe('✓ 20 tasks · ctrl+o');

    const expanded = lines(renderTaskResult({ details }, { expanded: true, isPartial: false }, createTheme()));
    expect(expanded).toHaveLength(21);
    expect(expanded.at(-1)).toBe('✓ 20 tasks');
  });

  it('reports the created task status', () => {
    const details = {
      action: 'upsert' as const,
      params: { tasks: [{ subject: 'a task' }] },
      tasks: [task({ status: 'pending' })],
      nextId: 2,
      rev: 1,
      upsert: { applied: [1], failed: 0 },
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));
    // One applied entry keeps the single row it has always had: no summary line.
    expect(rendered).toHaveLength(1);
    expect(rendered.at(-1)).toContain(STATUS_LABEL.pending);
  });

  it('renders one row per applied entry plus a summary', () => {
    const details = {
      action: 'upsert' as const,
      params: { tasks: [{ subject: 'a' }, { subject: 'b' }] },
      tasks: [task({ id: 1, subject: 'first' }), task({ id: 2, subject: 'second' })],
      nextId: 3,
      rev: 1,
      upsert: { applied: [1, 2], failed: 0 },
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));

    expect(rendered).toHaveLength(3);
    expect(rendered.at(-1)).toBe('✓ 2 applied');
  });

  it('marks a partial batch and renders no row for the failed entry', () => {
    const details = {
      action: 'upsert' as const,
      params: { tasks: [{ subject: 'a' }, { id: 99 }] },
      tasks: [task({ id: 1, subject: 'first' })],
      nextId: 2,
      rev: 1,
      upsert: { applied: [1], failed: 1 },
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));

    expect(rendered).toHaveLength(2);
    expect(rendered.at(-1)).toBe('! 1 applied · 1 failed');
  });

  it('renders successful rows and a warning summary for a partial assignment batch', () => {
    const details = {
      action: 'assign' as const,
      params: {
        assignments: [
          { id: 1, agent: 'architect' },
          { id: 2, agent: 'reviewer' },
          { id: 3, agent: 'experience' },
        ],
      },
      tasks: [
        task({
          id: 1,
          subject: 'map architecture',
          owner: 'architect',
          delegation: { requestId: 'r1', agent: 'architect', state: 'requested' },
        }),
        task({ id: 2, subject: 'blocked review' }),
        task({
          id: 3,
          subject: 'review experience',
          owner: 'experience',
          delegation: { requestId: 'r3', agent: 'experience', state: 'requested' },
        }),
      ],
      nextId: 4,
      rev: 1,
      assignment: { assigned: [1, 3], failed: 1 },
    };

    const rendered = lines(renderTaskResult({ details }, settled, createTheme()));

    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain('map architecture');
    expect(rendered[1]).toContain('review experience');
    expect(rendered.at(-1)).toBe('! 2 assigned · 1 failed');
  });

  it('degrades to a plain tick for a replayed result with no upsert summary', () => {
    const details = {
      action: 'upsert' as const,
      params: { tasks: [{ subject: 'a' }] },
      tasks: [task({ id: 1 })],
      nextId: 2,
      rev: 1,
    };

    expect(lines(renderTaskResult({ details }, settled, createTheme()))).toEqual(['✓ 0 applied']);
  });

  it('shows a running marker while a delegation is still streaming', () => {
    const result = { content: [{ type: 'text', text: 'Delegating task #4...' }] };

    expect(lines(renderTaskResult(result, { expanded: false, isPartial: true }, createTheme()))).toEqual([
      '◐ Delegating task #4...',
    ]);
  });
});

describe('selectors', () => {
  const blocker = task({ id: 1, subject: 'blocker' });
  const blocked = task({ id: 2, subject: 'blocked', blockedBy: [1] });
  const running = task({ id: 3, subject: 'running', status: 'in_progress' });
  const done = task({ id: 4, subject: 'done', status: 'completed' });
  const failed = task({ id: 5, subject: 'failed', status: 'failed' });
  const all = [blocker, blocked, running, done, failed];

  it('splits blocked tasks out of pending', () => {
    const groups = groupTasks(all);

    expect(groups.blocked.map((entry) => entry.id)).toEqual([2]);
    expect(groups.pending.map((entry) => entry.id)).toEqual([1]);
    expect(groups.inProgress.map((entry) => entry.id)).toEqual([3]);
  });

  it('renders only the newest snapshot when a malformed store repeats an id', () => {
    const projection = deriveTaskProjection([
      task({ id: 1, subject: 'stale', status: 'pending', updatedAt: '2026-08-18T10:22:00.000Z' }),
      task({ id: 1, subject: 'current', status: 'in_progress', updatedAt: '2026-08-18T10:23:00.000Z' }),
    ]);

    expect(projection.visible).toEqual([expect.objectContaining({ id: 1, subject: 'current', status: 'in_progress' })]);
    expect(projection.counts).toMatchObject({ total: 1, pending: 0, inProgress: 1 });
  });

  it('derives counts, groups, flags, and blocker semantics in one projection', () => {
    const deleted = task({ id: 6, subject: 'deleted', status: 'deleted', blockedBy: [1] });
    const resolved = task({ id: 7, subject: 'resolved', blockedBy: [4, 6, 99] });
    const blockedByFailure = task({ id: 8, subject: 'blocked by failure', blockedBy: [5] });

    const projection = deriveTaskProjection([...all, deleted, resolved, blockedByFailure]);

    expect(projection.visible.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(projection.counts).toEqual({
      total: 7,
      completed: 1,
      inProgress: 1,
      pending: 4,
      failed: 1,
      blocked: 2,
    });
    expect(projection.groups.blocked.map((entry) => entry.id)).toEqual([2, 8]);
    expect(projection.groups.pending.map((entry) => entry.id)).toEqual([1, 7]);
    expect(projection.showIds).toBe(true);
    expect(projection.hasActiveWork).toBe(true);
  });

  it('shows ids only once dependencies exist', () => {
    expect(shouldShowIds(all)).toBe(true);
    expect(shouldShowIds([blocker])).toBe(false);
  });

  it('reports active work only while something is in progress', () => {
    expect(hasActiveWork(all)).toBe(true);
    expect(hasActiveWork([blocker, done])).toBe(false);
  });

  it('keeps every row when the budget is generous', () => {
    const layout = selectOverlayLayout(all, all.length);

    expect(layout.visible).toHaveLength(all.length);
    expect(layout.hiddenCompleted).toBe(0);
    expect(layout.truncatedTail).toBe(0);
  });

  it('keeps source row positions stable across status updates', () => {
    const before = [
      task({ id: 1, status: 'pending' }),
      task({ id: 2, status: 'in_progress' }),
      task({ id: 3, status: 'completed' }),
    ];
    const after = [
      task({ id: 1, status: 'completed' }),
      task({ id: 2, status: 'pending' }),
      task({ id: 3, status: 'in_progress' }),
    ];

    expect(selectOverlayLayout(before, before.length).visible.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(selectOverlayLayout(after, after.length).visible.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it('renders prioritized rows in source order under a constrained budget', () => {
    const source = [
      task({ id: 1, status: 'failed' }),
      task({ id: 2, status: 'pending' }),
      task({ id: 3, status: 'in_progress' }),
      task({ id: 4, status: 'completed' }),
    ];

    const layout = selectOverlayLayout(source, 2);

    expect(layout.visible.map((entry) => entry.id)).toEqual([1, 3]);
    expect(layout.hiddenCompleted).toBe(1);
    expect(layout.truncatedTail).toBe(1);
  });

  it('drops completed rows first when the budget runs short', () => {
    const layout = selectOverlayLayout(all, 4);

    expect(layout.hiddenCompleted).toBe(1);
    expect(layout.visible.some((entry) => entry.status === 'completed')).toBe(false);
  });

  it('truncates active rows once dropping completed is not enough', () => {
    const layout = selectOverlayLayout(all, 2);

    expect(layout.visible).toHaveLength(2);
    expect(layout.truncatedTail).toBe(2);
    expect(layout.hiddenCompleted).toBe(1);
  });

  it('reports everything hidden when there is no budget at all', () => {
    const layout = selectOverlayLayout(all, 0);

    expect(layout.visible).toHaveLength(0);
    expect(layout.hiddenCompleted).toBe(1);
    expect(layout.truncatedTail).toBe(4);
  });
});
