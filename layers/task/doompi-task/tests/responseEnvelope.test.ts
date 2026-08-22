/**
 * `formatContent` is the only channel the model reads, so these assertions are
 * string-exact on purpose: the copy must not drift without a test noticing.
 */

import { describe, expect, it } from 'vitest';
import { applyTaskMutation, type Op } from '../src/exports/store/reducer';
import { emptyDocument, type TaskDocument, type TaskItemMutation } from '../src/exports/store/types';
import {
  formatAssignmentResults,
  formatContent,
  formatUpsertFailureText,
  MSG_UPSERT_PARTIAL,
} from '../src/exports/tool/responseEnvelope';

const NOW = '2026-07-31T00:00:00.000Z';

function upsert(document: TaskDocument, tasks: TaskItemMutation[]): { document: TaskDocument; op: Op } {
  return applyTaskMutation(document, 'upsert', { tasks }, NOW);
}

function render(document: TaskDocument, tasks: TaskItemMutation[]): string {
  const result = upsert(document, tasks);
  return formatContent(result.op, result.document);
}

describe('formatAssignmentResults', () => {
  it('summarizes an all-success fan-out once instead of repeating manager boilerplate', () => {
    expect(
      formatAssignmentResults([
        { index: 0, id: 1, agent: 'architect', ok: true, message: 'verbose runtime message' },
        { index: 1, id: 2, agent: 'reviewer', ok: true, message: 'another verbose runtime message' },
      ]),
    ).toBe(
      [
        'Assigned 2/2 tasks.',
        '- [0] Delegated #1 to architect',
        '- [1] Delegated #2 to reviewer',
        '',
        'All assignments are running independently in the background. Continue non-overlapping work, or end your turn.',
      ].join('\n'),
    );
  });
});

describe('formatContent upsert', () => {
  it('renders a single create as one bare line', () => {
    expect(render(emptyDocument(), [{ subject: 'Wire up auth guard' }])).toBe(
      'Created #1: Wire up auth guard (pending)',
    );
  });

  it('renders a single update as one bare line', () => {
    const seeded = upsert(emptyDocument(), [{ subject: 'a' }, { subject: 'b' }]);

    expect(render(seeded.document, [{ id: 1, status: 'in_progress' }])).toBe('Updated #1 (pending -> in_progress)');
  });

  it('renders a no-op update as an explicit no change', () => {
    const seeded = upsert(emptyDocument(), [{ subject: 'a' }, { subject: 'b' }]);

    expect(render(seeded.document, [{ id: 1, status: 'pending' }])).toBe(
      'No change: #1 already matches the requested values (status: pending)',
    );
  });

  it('appends the clear nudge once when the last entry completes the list', () => {
    const seeded = upsert(emptyDocument(), [{ subject: 'a' }, { subject: 'b' }]);

    const rendered = render(seeded.document, [
      { id: 1, status: 'completed' },
      { id: 2, status: 'completed' },
    ]);

    expect(rendered).toBe(
      [
        'Upsert applied 2/2 entries.',
        '- [0] Updated #1 (pending -> completed)',
        '- [1] Updated #2 (pending -> completed)',
        'All tasks are completed. Review the full task list once more, then close it with task {"action":"clear"}.',
      ].join('\n'),
    );
  });

  it('renders an all-success batch with a header and per-entry lines', () => {
    const rendered = render(emptyDocument(), [
      { ref: 'api', subject: 'Design the API' },
      { subject: 'Implement the API', blockedBy: ['api'] },
    ]);

    expect(rendered).toBe(
      [
        'Upsert applied 2/2 entries.',
        '- [0] Created #1 (ref "api"): Design the API (pending)',
        '- [1] Created #2: Implement the API (pending) — blocked by #1',
      ].join('\n'),
    );
  });

  it('renders a mixed batch with the failure and the retry steering', () => {
    const rendered = render(emptyDocument(), [{ subject: 'a' }, { id: 99, status: 'completed' }]);

    expect(rendered).toBe(
      [
        'Upsert applied 1/2 entries; 1 failed.',
        '- [0] Created #1: a (pending)',
        '- [1] Failed #99: #99 not found',
        '',
        MSG_UPSERT_PARTIAL,
      ].join('\n'),
    );
  });

  it('tells the model a corrected retry is safe rather than warning it off', () => {
    expect(MSG_UPSERT_PARTIAL).toContain('a corrected retry is safe');
    expect(MSG_UPSERT_PARTIAL).toContain('an entry without an id creates a second task');
  });
});

describe('formatContent read and lifecycle actions', () => {
  const board: TaskDocument = {
    version: 1,
    rev: 4,
    nextId: 5,
    tasks: [
      { id: 1, subject: 'Design', status: 'completed' },
      {
        id: 2,
        subject: 'Build',
        status: 'in_progress',
        activeForm: 'writing the reducer',
        blockedBy: [1],
        owner: 'impl',
        description: 'Long-form brief',
        delegation: { requestId: 'r1', agent: 'impl', state: 'running', model: 'sonnet' },
      },
      { id: 3, subject: 'Gone', status: 'deleted' },
      {
        id: 4,
        subject: 'Review',
        status: 'failed',
        delegation: {
          requestId: 'r2',
          agent: 'reviewer',
          state: 'cancelled',
          result: { status: 'error', error: 'timed out', output: 'partial', outputPath: '/tmp/out.md' },
        },
      },
    ],
  };

  it('renders a list, hiding tombstones and marking blockers and delegates', () => {
    const rendered = formatContent({ kind: 'list', includeDeleted: false }, board);

    expect(rendered).toBe(
      [
        '[completed] #1 Design',
        '[in_progress] #2 Build (writing the reducer) [impl] ⛓ #1',
        // A cancelled delegation is not an owner, so no agent chip.
        '[failed] #4 Review',
      ].join('\n'),
    );
  });

  it('includes tombstones when asked', () => {
    const rendered = formatContent({ kind: 'list', includeDeleted: true }, board);

    expect(rendered).toContain('[deleted] #3 Gone');
  });

  it('filters a list by status', () => {
    expect(formatContent({ kind: 'list', includeDeleted: false, statusFilter: 'completed' }, board)).toBe(
      '[completed] #1 Design',
    );
  });

  it('says so when a list has nothing to show', () => {
    expect(formatContent({ kind: 'list', includeDeleted: false }, emptyDocument())).toBe('No tasks');
  });

  it('renders a get with every optional detail and the inverse blocks edge', () => {
    expect(formatContent({ kind: 'get', task: board.tasks[1] }, board)).toBe(
      [
        '#2 [in_progress] Build',
        '  description: Long-form brief',
        '  activeForm: writing the reducer',
        '  blockedBy: #1',
        '  owner: impl',
        '  delegated to: impl (running)',
        '  model: sonnet',
      ].join('\n'),
    );
  });

  it('renders a get for a task that blocks another, with its delegation result', () => {
    expect(formatContent({ kind: 'get', task: board.tasks[0] }, board)).toBe(
      ['#1 [completed] Design', '  blocks: #2'].join('\n'),
    );
    expect(formatContent({ kind: 'get', task: board.tasks[3] }, board)).toBe(
      [
        '#4 [failed] Review',
        '  delegated to: reviewer (cancelled)',
        '  error: timed out',
        '  output file: /tmp/out.md',
        '  output: partial',
      ].join('\n'),
    );
  });

  it('renders delete, clear and error', () => {
    expect(formatContent({ kind: 'delete', id: 3, subject: 'Gone' }, board)).toBe('Deleted #3: Gone');
    expect(formatContent({ kind: 'clear', count: 4 }, board)).toBe('Closed task list (cleared 4 tasks)');
    expect(formatContent({ kind: 'error', message: '#9 not found' }, board)).toBe('Error: #9 not found');
  });
});

describe('formatUpsertFailureText', () => {
  it('reduces a single failed entry to its own message', () => {
    const result = upsert(emptyDocument(), [{ id: 99, status: 'completed' }]);

    expect(formatUpsertFailureText(result.op as Extract<Op, { kind: 'upsert' }>)).toBe('#99 not found');
  });

  it('lists every entry and says nothing was committed', () => {
    const seeded = upsert(emptyDocument(), [{ subject: 'a' }]);

    const result = upsert(seeded.document, [{ id: 1 }, { id: 99, status: 'completed' }]);

    expect(formatUpsertFailureText(result.op as Extract<Op, { kind: 'upsert' }>)).toBe(
      [
        'no entry was applied.',
        '- [0] Failed #1: nothing to change: provide at least one of subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy',
        '- [1] Failed #99: #99 not found',
        'No task changed, so the whole call can be resent once corrected.',
      ].join('\n'),
    );
  });
});
