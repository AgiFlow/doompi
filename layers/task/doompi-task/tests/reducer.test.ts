import { describe, expect, it } from 'vitest';
import { applyTaskMutation, MAX_UPSERT_ITEMS } from '../src/exports/store/reducer';
import { emptyDocument, type TaskDocument, type TaskItemMutation } from '../src/exports/store/types';

const NOW = '2026-07-31T00:00:00.000Z';

/** Seeds through a single batch, so every fixture also exercises batch id allocation. */
function documentWith(subjects: string[]): TaskDocument {
  return applyTaskMutation(emptyDocument(), 'upsert', { tasks: subjects.map((subject) => ({ subject })) }, NOW)
    .document;
}

function upsert(document: TaskDocument, tasks: TaskItemMutation[]) {
  return applyTaskMutation(document, 'upsert', { tasks }, NOW);
}

/** The unprefixed message of the entry at `index`, or undefined if it did not fail. */
function failureAt(op: unknown, index: number): string | undefined {
  const items = (op as { items?: Array<{ index: number; kind: string; message?: string }> }).items ?? [];
  const item = items.find((candidate) => candidate.index === index);
  return item?.kind === 'failed' ? item.message : undefined;
}

describe('applyTaskMutation upsert creates', () => {
  it('assigns sequential ids and pending status', () => {
    const document = documentWith(['first', 'second']);

    expect(document.tasks.map((task) => [task.id, task.subject, task.status])).toEqual([
      [1, 'first', 'pending'],
      [2, 'second', 'pending'],
    ]);
    expect(document.nextId).toBe(3);
  });

  it('reports each created entry with its id and index', () => {
    const result = upsert(emptyDocument(), [{ subject: 'first' }, { subject: 'second' }]);

    expect(result.op).toEqual({
      kind: 'upsert',
      applied: 2,
      failed: 0,
      items: [
        { index: 0, kind: 'created', id: 1, subject: 'first', status: 'pending' },
        { index: 1, kind: 'created', id: 2, subject: 'second', status: 'pending' },
      ],
    });
  });

  it('rejects a blank subject', () => {
    const result = upsert(emptyDocument(), [{ subject: '   ' }]);

    expect(failureAt(result.op, 0)).toBe('subject must not be blank');
    expect(result.op).toMatchObject({ applied: 0, failed: 1 });
  });

  it('rejects a missing subject', () => {
    const result = upsert(emptyDocument(), [{ description: 'no subject' }]);

    expect(failureAt(result.op, 0)).toBe('subject is required when the entry has no id');
  });

  it('rejects blockedBy pointing at a missing task', () => {
    const result = upsert(emptyDocument(), [{ subject: 'a', blockedBy: [9] }]);

    expect(failureAt(result.op, 0)).toBe('blockedBy: #9 not found');
  });

  it('honours a starting status other than pending', () => {
    const result = upsert(emptyDocument(), [{ subject: 'a', status: 'in_progress', activeForm: 'doing a' }]);

    expect(result.document.tasks[0]).toMatchObject({ status: 'in_progress', activeForm: 'doing a' });
    expect(result.op).toMatchObject({ items: [{ kind: 'created', status: 'in_progress' }] });
  });

  it('refuses to create a task that is already a tombstone', () => {
    const result = upsert(emptyDocument(), [{ subject: 'a', status: 'deleted' }]);

    expect(failureAt(result.op, 0)).toBe('cannot create a task with status deleted; create it, then use action delete');
    expect(result.document.tasks).toHaveLength(0);
  });

  it('refuses delta dependency fields on a new entry', () => {
    const result = upsert(documentWith(['first']), [{ subject: 'a', addBlockedBy: [1] }]);

    expect(failureAt(result.op, 0)).toBe(
      'addBlockedBy / removeBlockedBy are only for an entry with an id; a new task uses blockedBy',
    );
  });
});

describe('applyTaskMutation upsert updates', () => {
  it('records a status transition as changed', () => {
    const result = upsert(documentWith(['first']), [{ id: 1, status: 'in_progress' }]);

    expect(result.op).toEqual({
      kind: 'upsert',
      applied: 1,
      failed: 0,
      items: [{ index: 0, kind: 'updated', id: 1, fromStatus: 'pending', toStatus: 'in_progress' }],
    });
  });

  it('reports a no-op update as unchanged', () => {
    const result = upsert(documentWith(['first']), [{ id: 1, status: 'pending' }]);

    expect(result.op).toMatchObject({ applied: 1, items: [{ kind: 'unchanged', id: 1, status: 'pending' }] });
  });

  it('rejects an illegal transition out of completed', () => {
    const completed = upsert(documentWith(['first']), [{ id: 1, status: 'completed' }]);

    const result = upsert(completed.document, [{ id: 1, status: 'in_progress' }]);

    expect(failureAt(result.op, 0)).toBe('illegal transition completed -> in_progress');
  });

  it('allows retrying a failed task', () => {
    const failed = upsert(documentWith(['first']), [{ id: 1, status: 'failed' }]);

    const result = upsert(failed.document, [{ id: 1, status: 'in_progress' }]);

    expect(result.op).toMatchObject({ items: [{ kind: 'updated', fromStatus: 'failed', toStatus: 'in_progress' }] });
  });

  it('requires at least one mutable field', () => {
    const result = upsert(documentWith(['first']), [{ id: 1 }]);

    expect(failureAt(result.op, 0)).toContain('nothing to change');
  });

  it('rejects an unknown id rather than creating a task', () => {
    const document = documentWith(['first']);

    const result = upsert(document, [{ id: 99, status: 'completed' }]);

    expect(failureAt(result.op, 0)).toBe('#99 not found');
    expect(result.document.tasks).toHaveLength(1);
  });

  it('refuses the absolute dependency set on an entry with an id', () => {
    const result = upsert(documentWith(['first', 'second']), [{ id: 2, blockedBy: [1] }]);

    expect(failureAt(result.op, 0)).toBe(
      'blockedBy is only for a new entry; use addBlockedBy / removeBlockedBy on an entry that has an id',
    );
  });

  it('merges blockedBy additively and deletes metadata keys set to null', () => {
    const document = documentWith(['first', 'second', 'third']);

    const withMetadata = upsert(document, [{ id: 3, metadata: { a: 1, b: 2 } }]);
    const blocked = upsert(withMetadata.document, [{ id: 3, addBlockedBy: [1, 2] }]);
    const trimmed = upsert(blocked.document, [{ id: 3, removeBlockedBy: [1], metadata: { a: null } }]);

    const task = trimmed.document.tasks.find((candidate) => candidate.id === 3);
    expect(task?.blockedBy).toEqual([2]);
    expect(task?.metadata).toEqual({ b: 2 });
  });

  it('rejects a self-block', () => {
    const result = upsert(documentWith(['first']), [{ id: 1, addBlockedBy: [1] }]);

    expect(failureAt(result.op, 0)).toBe('cannot block #1 on itself');
  });

  it('rejects a dependency cycle', () => {
    const linked = upsert(documentWith(['first', 'second']), [{ id: 1, addBlockedBy: [2] }]);

    const result = upsert(linked.document, [{ id: 2, addBlockedBy: [1] }]);

    expect(failureAt(result.op, 0)).toBe('addBlockedBy would create a cycle in the blockedBy graph');
  });

  it('allows a remove that breaks a cycle before the add that would close it', () => {
    // #1 blocked by #2; re-pointing #1 at #3 and #2 at #1 in turn is legal, but
    // a cycle check run against the pre-edit array would see #1 -> #2 -> #1.
    const seeded = upsert(documentWith(['first', 'second', 'third']), [{ id: 1, addBlockedBy: [2] }]);

    const repointed = upsert(seeded.document, [{ id: 1, removeBlockedBy: [2], addBlockedBy: [3] }]);
    const result = upsert(repointed.document, [{ id: 2, addBlockedBy: [1] }]);

    expect(failureAt(result.op, 0)).toBeUndefined();
    expect(result.document.tasks.find((task) => task.id === 1)?.blockedBy).toEqual([3]);
    expect(result.document.tasks.find((task) => task.id === 2)?.blockedBy).toEqual([1]);
  });
});

describe('applyTaskMutation upsert batching', () => {
  it('rejects the whole call when tasks is missing or empty', () => {
    expect(applyTaskMutation(emptyDocument(), 'upsert', {}, NOW).op).toMatchObject({ kind: 'error' });
    expect(upsert(emptyDocument(), []).op).toMatchObject({ kind: 'error' });
  });

  it('rejects a call over the entry cap without applying any of it', () => {
    const tasks = Array.from({ length: MAX_UPSERT_ITEMS + 1 }, (_, index) => ({ subject: `t${index}` }));

    const result = upsert(emptyDocument(), tasks);

    expect(result.op).toMatchObject({ kind: 'error' });
    expect(result.document.tasks).toHaveLength(0);
  });

  it('rejects new tasks at the configured board limit but still allows updates', () => {
    const document = documentWith(['first', 'second']);

    const result = applyTaskMutation(
      document,
      'upsert',
      { tasks: [{ id: 1, status: 'in_progress' }, { subject: 'third' }] },
      NOW,
      2,
    );

    expect(result.op).toMatchObject({ applied: 1, failed: 1 });
    expect(result.document.tasks[0].status).toBe('in_progress');
    expect(failureAt(result.op, 1)).toContain('delete completed tasks first');
  });

  it('partially applies creations until the configured board limit is reached', () => {
    const result = applyTaskMutation(
      documentWith(['first']),
      'upsert',
      { tasks: [{ subject: 'second' }, { subject: 'third' }] },
      NOW,
      2,
    );

    expect(result.op).toMatchObject({ applied: 1, failed: 1 });
    expect(result.document.tasks.map((task) => task.subject)).toEqual(['first', 'second']);
    expect(failureAt(result.op, 1)).toContain('task limit of 2 reached');
  });

  it('does not count deleted completed tasks against the configured board limit', () => {
    const completed = upsert(documentWith(['first', 'second']), [{ id: 1, status: 'completed' }]);
    const trimmed = applyTaskMutation(completed.document, 'delete', { id: 1 }, NOW);

    const result = applyTaskMutation(trimmed.document, 'upsert', { tasks: [{ subject: 'third' }] }, NOW, 2);

    expect(result.op).toMatchObject({ applied: 1, failed: 0 });
    expect(result.document.tasks.find((task) => task.subject === 'third')).toMatchObject({ status: 'pending' });
  });

  it('commits the entries that pass and reports the ones that fail', () => {
    const result = upsert(emptyDocument(), [{ subject: 'a' }, { id: 99, status: 'completed' }, { subject: 'b' }]);

    expect(result.op).toMatchObject({ applied: 2, failed: 1 });
    expect(result.document.tasks.map((task) => task.subject)).toEqual(['a', 'b']);
    expect(failureAt(result.op, 1)).toBe('#99 not found');
  });

  it('does not burn an id on a failed entry', () => {
    const result = upsert(emptyDocument(), [{ subject: 'a' }, { subject: '  ' }, { subject: 'c' }]);

    expect(result.document.tasks.map((task) => task.id)).toEqual([1, 2]);
    expect(result.document.nextId).toBe(3);
  });

  it('returns the original document untouched when every entry fails', () => {
    const document = documentWith(['first']);

    const result = upsert(document, [{ id: 98 }, { id: 99, status: 'completed' }]);

    expect(result.op).toMatchObject({ applied: 0, failed: 2 });
    expect(result.document).toBe(document);
  });

  it('threads the document so a later entry sees an earlier one', () => {
    const result = upsert(documentWith(['first']), [
      { id: 1, status: 'in_progress' },
      { id: 1, status: 'completed' },
    ]);

    expect(result.op).toMatchObject({
      items: [
        { index: 0, kind: 'updated', fromStatus: 'pending', toStatus: 'in_progress' },
        { index: 1, kind: 'updated', fromStatus: 'in_progress', toStatus: 'completed' },
      ],
    });
  });

  it('lets a later entry update a task created earlier in the same call', () => {
    const result = upsert(emptyDocument(), [{ subject: 'a' }, { id: 1, status: 'in_progress' }]);

    expect(result.op).toMatchObject({ applied: 2, failed: 0 });
    expect(result.document.tasks[0].status).toBe('in_progress');
  });
});

describe('applyTaskMutation upsert refs', () => {
  it('resolves a ref declared by an earlier entry', () => {
    const result = upsert(emptyDocument(), [
      { ref: 'api', subject: 'Design the API' },
      { subject: 'Implement the API', blockedBy: ['api'] },
    ]);

    expect(result.document.tasks[1].blockedBy).toEqual([1]);
    expect(result.op).toMatchObject({
      items: [
        { index: 0, kind: 'created', ref: 'api', id: 1 },
        { index: 1, kind: 'created', id: 2, blockedBy: [1] },
      ],
    });
  });

  it('rejects a forward ref, since refs resolve backward only', () => {
    const result = upsert(emptyDocument(), [
      { subject: 'Implement the API', blockedBy: ['api'] },
      { ref: 'api', subject: 'Design the API' },
    ]);

    expect(failureAt(result.op, 0)).toContain('unknown ref "api"');
    expect(result.op).toMatchObject({ applied: 1, failed: 1 });
  });

  it('cascades a failed ref owner to every entry that depends on it', () => {
    const result = upsert(emptyDocument(), [
      { ref: 'api', subject: '   ' },
      { ref: 'impl', subject: 'Implement', blockedBy: ['api'] },
      { subject: 'Test', blockedBy: ['impl'] },
    ]);

    expect(result.op).toMatchObject({ applied: 0, failed: 3 });
    expect(failureAt(result.op, 1)).toBe('blockedBy: ref "api" refers to item[0], which failed');
    expect(failureAt(result.op, 2)).toBe('blockedBy: ref "impl" refers to item[1], which failed');
  });

  it('rejects a duplicate ref', () => {
    const result = upsert(emptyDocument(), [
      { ref: 'api', subject: 'first' },
      { ref: 'api', subject: 'second' },
    ]);

    expect(failureAt(result.op, 1)).toContain('duplicate ref "api"');
  });

  it('rejects a ref on an entry that also carries an id', () => {
    const result = upsert(documentWith(['first']), [{ id: 1, ref: 'api', status: 'completed' }]);

    expect(failureAt(result.op, 0)).toBe('ref is only valid when creating a task; drop the id, or drop the ref');
  });

  it('rejects a ref that does not start with a letter', () => {
    const result = upsert(emptyDocument(), [{ ref: '3api', subject: 'a' }]);

    expect(failureAt(result.op, 0)).toContain('is invalid');
  });

  it('rejects a numeric-looking dependency string rather than coercing it', () => {
    const result = upsert(documentWith(['first']), [{ subject: 'a', blockedBy: ['3'] }]);

    expect(failureAt(result.op, 0)).toBe('blockedBy: "3" is not a valid ref; pass an existing task id as a number');
  });

  it('resolves a ref in addBlockedBy on a later entry', () => {
    const result = upsert(documentWith(['existing']), [
      { ref: 'fresh', subject: 'new work' },
      { id: 1, addBlockedBy: ['fresh'] },
    ]);

    expect(result.document.tasks.find((task) => task.id === 1)?.blockedBy).toEqual([2]);
  });
});

describe('applyTaskMutation delete and clear', () => {
  it('tombstones rather than removing', () => {
    const result = applyTaskMutation(documentWith(['first']), 'delete', { id: 1 }, NOW);

    expect(result.document.tasks[0].status).toBe('deleted');
    expect(result.op).toEqual({ kind: 'delete', id: 1, subject: 'first' });
  });

  it('refuses to delete a task with a running delegation', () => {
    const document = documentWith(['first']);
    document.tasks[0].delegation = { requestId: 'r1', agent: 'reviewer', state: 'running' };

    const result = applyTaskMutation(document, 'delete', { id: 1 }, NOW);

    expect(result.op).toMatchObject({ kind: 'error' });
    expect((result.op as { message: string }).message).toContain('running delegation');
  });

  it('resets ids on clear', () => {
    const result = applyTaskMutation(documentWith(['first', 'second']), 'clear', {}, NOW);

    expect(result.document.tasks).toEqual([]);
    expect(result.document.nextId).toBe(1);
    expect(result.op).toEqual({ kind: 'clear', count: 2 });
  });

  it('refuses to clear while a delegation is in flight', () => {
    const document = documentWith(['first']);
    document.tasks[0].delegation = { requestId: 'r1', agent: 'reviewer', state: 'requested' };

    const result = applyTaskMutation(document, 'clear', {}, NOW);

    expect(result.op).toMatchObject({ kind: 'error' });
    expect(result.document.tasks).toHaveLength(1);
  });
});

describe('applyTaskMutation read actions', () => {
  it('does not modify the document on list', () => {
    const document = documentWith(['first']);

    const result = applyTaskMutation(document, 'list', { status: 'pending' }, NOW);

    expect(result.document).toBe(document);
    expect(result.op).toEqual({ kind: 'list', includeDeleted: false, statusFilter: 'pending' });
  });

  it('errors when getting a missing task', () => {
    const result = applyTaskMutation(emptyDocument(), 'get', { id: 4 }, NOW);

    expect(result.op).toEqual({ kind: 'error', message: '#4 not found' });
  });
});
