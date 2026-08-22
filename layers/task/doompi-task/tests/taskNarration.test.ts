import { describe, expect, it, vi } from 'vitest';
import { narrateTaskCommit, type TaskNarrationSink } from '../src/services/narration/taskNarration.ts';
import { emptyDocument, type Task, type TaskDocument } from '../src/exports/store/types';

function document(tasks: Task[]): TaskDocument {
  return { ...emptyDocument(), nextId: tasks.length + 1, tasks };
}

function task(id: number, subject: string, status: Task['status'] = 'pending'): Task {
  return { id, subject, status };
}

function requester() {
  return { narrate: vi.fn() } satisfies TaskNarrationSink;
}

describe('task narration publisher', () => {
  it('narrates the full visible list once after a creation batch', () => {
    const speech = requester();
    const committed = document([
      task(1, 'Inspect architecture'),
      task(2, 'Implement channel'),
      task(3, 'Old tombstone', 'deleted'),
    ]);

    narrateTaskCommit(speech, emptyDocument(), committed);

    expect(speech.narrate).toHaveBeenCalledOnce();
    expect(speech.narrate).toHaveBeenCalledWith(
      'Task list created. Task 1: Inspect architecture. Task 2: Implement channel.',
    );
  });

  it('announces only newly added tasks when extending an existing list', () => {
    const speech = requester();
    const previous = document([task(1, 'Inspect architecture')]);
    const committed = document([
      task(1, 'Inspect architecture'),
      task(2, 'Implement channel'),
      task(3, 'Verify behavior'),
    ]);

    narrateTaskCommit(speech, previous, committed);

    expect(speech.narrate).toHaveBeenCalledOnce();
    expect(speech.narrate).toHaveBeenCalledWith(
      'Task list updated. Task 2: Implement channel. Task 3: Verify behavior.',
    );
  });

  it('does not announce newly created tombstones', () => {
    const speech = requester();
    const previous = document([task(1, 'Inspect architecture')]);
    const committed = document([task(1, 'Inspect architecture'), task(2, 'Removed', 'deleted')]);

    narrateTaskCommit(speech, previous, committed);

    expect(speech.narrate).not.toHaveBeenCalled();
  });

  it('announces committed completion and confirmed cancellation transitions', () => {
    const speech = requester();
    const previous = document([
      task(1, 'Run tests', 'in_progress'),
      {
        ...task(2, 'Review implementation', 'in_progress'),
        delegation: { requestId: 'request-2', agent: 'reviewer', state: 'running' },
      },
    ]);
    const committed = document([
      task(1, 'Run tests', 'completed'),
      {
        ...task(2, 'Review implementation'),
        delegation: { requestId: 'request-2', agent: 'reviewer', state: 'cancelled' },
      },
    ]);

    narrateTaskCommit(speech, previous, committed);

    expect(speech.narrate.mock.calls).toEqual([
      ['Task completed: Run tests.'],
      ['Task cancelled: Review implementation.'],
    ]);
  });

  it('ignores unrelated edits and does not double-announce already terminal tasks', () => {
    const speech = requester();
    const previous = document([task(1, 'Done', 'completed')]);
    const committed = document([{ ...task(1, 'Still done', 'completed'), owner: 'main' }]);

    narrateTaskCommit(speech, previous, committed);

    expect(speech.narrate).not.toHaveBeenCalled();
  });
});
