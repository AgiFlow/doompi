import { describe, expect, it } from 'vitest';
import { taskCallView, taskDetailsView, taskResultView, taskRow, type TaskView } from '../src/web/taskToolFormat.ts';

const task = (id: number, status: TaskView['status'], extra: Partial<TaskView> = {}): TaskView => ({
  id,
  subject: `task ${id}`,
  status,
  ...extra,
});

const details = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  action: 'list',
  params: {},
  tasks: [],
  ...overrides,
});

const settled = { output: '', expanded: false, isPartial: false, isError: false };

describe('the task web call header', () => {
  it('narrows an upsert to create, update, or a batch count', () => {
    expect(taskCallView({ action: 'upsert', tasks: [{ subject: 'write  tests' }] })).toEqual({
      glyph: '+',
      action: 'upsert',
      subject: 'write tests',
      subjectTone: 'dim',
    });
    expect(taskCallView({ action: 'upsert', tasks: [{ id: 3, status: 'completed' }] })).toMatchObject({
      glyph: '→',
      subject: '#3',
      subjectTone: 'accent',
    });
    expect(taskCallView({ action: 'upsert', tasks: [{ id: 3, subject: 'renamed' }] }).subject).toBe('renamed');
    expect(taskCallView({ action: 'upsert', tasks: [{ id: 1 }, { subject: 'new' }] })).toMatchObject({
      glyph: '✎',
      subject: '2 tasks',
    });
    expect(taskCallView({ action: 'upsert' })).toEqual({ glyph: '✎', action: 'upsert', subjectTone: 'dim' });
  });

  it('names the assignee, the acted-on id, and the list filter', () => {
    expect(taskCallView({ action: 'assign', assignments: [{ id: 2, agent: 'coder' }] })).toEqual({
      glyph: '⇒',
      action: 'assign',
      subject: '#2',
      subjectTone: 'accent',
      detail: '→ coder',
    });
    expect(taskCallView({ action: 'assign', assignments: [{ id: 2 }, { id: 3 }] }).subject).toBe('2 tasks');
    expect(taskCallView({ action: 'cancel', id: 7 })).toMatchObject({
      glyph: '⊗',
      subject: '#7',
      subjectTone: 'accent',
    });
    expect(taskCallView({ action: 'get', id: { bad: true } }).subject).toBe('#?');
    expect(taskCallView({ action: 'list', status: 'in_progress' })).toEqual({
      glyph: '☰',
      action: 'list',
      subjectTone: 'dim',
      detail: 'in progress',
    });
    expect(taskCallView({ action: 'clear' })).toEqual({ glyph: '∅', action: 'clear', subjectTone: 'dim' });
    expect(taskCallView({ action: 'bogus' })).toEqual({ glyph: '?', action: 'bogus', subjectTone: 'dim' });
    expect(taskCallView({})).toEqual({ glyph: '?', action: 'task', subjectTone: 'dim' });
  });
});

describe('the task web result view', () => {
  it('narrows the wire details and drops what is not a task', () => {
    expect(taskDetailsView('junk')).toBeNull();
    expect(taskDetailsView({ action: 'nope', tasks: [] })).toBeNull();
    const view = taskDetailsView(
      details({
        action: 'upsert',
        params: { x: 1 },
        tasks: [
          {
            id: 1,
            subject: 'a',
            status: 'pending',
            blockedBy: [2, 'x'],
            delegation: { agent: 'coder', state: 'running' },
          },
          { id: 2, subject: 'b', status: 'weird' },
          'junk',
        ],
        error: 'e',
        upsert: { applied: [1, 'x'], failed: 'n' },
        assignment: { assigned: [1], failed: 2 },
      }),
    );
    expect(view).toEqual({
      action: 'upsert',
      params: { x: 1 },
      tasks: [
        { id: 1, subject: 'a', status: 'pending', blockedBy: [2], delegation: { agent: 'coder', state: 'running' } },
      ],
      error: 'e',
      upsert: { applied: [1], failed: 0 },
      assignment: { assigned: [1], failed: 2 },
    });
  });

  it('builds rows with chips and strikes closed tasks', () => {
    expect(
      taskRow(task(1, 'in_progress', { activeForm: 'writing', delegation: { agent: 'coder' }, blockedBy: [2] })),
    ).toEqual({
      id: 1,
      glyph: '◐',
      subject: 'task 1',
      status: 'in_progress',
      closed: false,
      agent: 'coder',
      activeForm: 'writing',
      blockedBy: [2],
    });
    expect(taskRow(task(2, 'completed', { activeForm: 'ignored' }))).toMatchObject({ closed: true, glyph: '●' });
    expect(taskRow(task(2, 'completed')).activeForm).toBeUndefined();
  });

  it('shows the last streamed line while running and error text on failure', () => {
    expect(
      taskResultView({ ...settled, details: undefined, output: 'a\nworking on it\n', isPartial: true }).status,
    ).toEqual({
      glyph: '◐',
      tone: 'running',
      text: 'working on it',
    });
    expect(taskResultView({ ...settled, details: undefined, isPartial: true }).status?.text).toBe('working');
    expect(taskResultView({ ...settled, details: undefined, output: 'no such task', isError: true })).toEqual({
      rows: [],
      errorLines: [],
      status: { glyph: '✗', tone: 'error', text: 'no such task' },
    });
    const multi = taskResultView({ ...settled, details: details({ error: 'one\ntwo\nthree' }) });
    expect(multi.errorLines).toEqual(['one', 'two', 'three']);
    expect(multi.status).toEqual({ glyph: '✗', tone: 'error', text: '' });
    const many = Array.from({ length: 10 }, (_, index) => `e${index}`).join('\n');
    expect(taskResultView({ ...settled, details: details({ error: many }) }).errorLines).toHaveLength(8);
    expect(taskResultView({ ...settled, details: details({ error: many }), expanded: true }).errorLines).toHaveLength(
      10,
    );
  });

  it('lists the filtered rows with a count, and reports clear', () => {
    const tasks = [task(1, 'pending'), task(2, 'deleted'), task(3, 'completed')];
    const listed = taskResultView({ ...settled, details: details({ tasks }) });
    expect(listed.rows.map((row) => row.id)).toEqual([1, 3]);
    expect(listed.status).toEqual({ glyph: '✓', tone: 'ok', text: '2 tasks' });
    expect(
      taskResultView({ ...settled, details: details({ tasks, params: { includeDeleted: true } }) }).rows,
    ).toHaveLength(3);
    expect(
      taskResultView({ ...settled, details: details({ tasks, params: { status: 'completed' } }) }).status?.text,
    ).toBe('1 task');
    expect(taskResultView({ ...settled, details: details({}) }).status?.text).toBe('no tasks');
    const long = Array.from({ length: 10 }, (_, index) => task(index + 1, 'pending'));
    const collapsed = taskResultView({ ...settled, details: details({ tasks: long }) });
    expect(collapsed.rows).toHaveLength(8);
    expect(collapsed.status?.text).toBe('10 tasks · 2 more');
    expect(taskResultView({ ...settled, details: details({ tasks: long }), expanded: true }).rows).toHaveLength(10);
    expect(taskResultView({ ...settled, details: details({ action: 'clear' }) }).status).toEqual({
      glyph: '✓',
      tone: 'ok',
      text: 'cleared',
    });
  });

  it('reports upsert and assign batches, keeping the single-row common case', () => {
    const tasks = [task(1, 'pending'), task(2, 'in_progress'), task(3, 'pending')];
    const single = taskResultView({
      ...settled,
      details: details({ action: 'upsert', tasks, upsert: { applied: [2], failed: 0 } }),
    });
    expect(single.rows.map((row) => row.id)).toEqual([2]);
    expect(single.status).toBeNull();
    const batch = taskResultView({
      ...settled,
      details: details({ action: 'upsert', tasks, upsert: { applied: [1, 3], failed: 1 } }),
    });
    expect(batch.rows.map((row) => row.id)).toEqual([1, 3]);
    expect(batch.status).toEqual({ glyph: '!', tone: 'warning', text: '2 applied · 1 failed' });
    expect(taskResultView({ ...settled, details: details({ action: 'upsert', tasks }) }).status?.text).toBe(
      '0 applied',
    );
    const assigned = taskResultView({
      ...settled,
      details: details({ action: 'assign', tasks, assignment: { assigned: [1, 2], failed: 0 } }),
    });
    expect(assigned.status).toEqual({ glyph: '✓', tone: 'ok', text: '2 assigned' });
    const many = Array.from({ length: 9 }, (_, index) => task(index + 1, 'pending'));
    const clipped = taskResultView({
      ...settled,
      details: details({
        action: 'assign',
        tasks: many,
        assignment: { assigned: many.map((item) => item.id), failed: 0 },
      }),
    });
    expect(clipped.rows).toHaveLength(8);
    expect(clipped.status?.text).toBe('9 assigned · 1 more');
  });

  it('names the task an id-bearing action acted on, or ticks', () => {
    const tasks = [task(4, 'failed')];
    const got = taskResultView({ ...settled, details: details({ action: 'get', params: { id: 4 }, tasks }) });
    expect(got.rows.map((row) => row.id)).toEqual([4]);
    expect(got.status).toBeNull();
    expect(
      taskResultView({ ...settled, details: details({ action: 'get', params: { id: 9 }, tasks }) }).status,
    ).toEqual({
      glyph: '✓',
      tone: 'ok',
      text: '',
    });
    expect(taskResultView({ ...settled, details: undefined }).status).toEqual({ glyph: '✓', tone: 'ok', text: '' });
  });
});
