import { describe, expect, it } from 'vitest';
import {
  deriveBlocks,
  detectCycle,
  isBlocked,
  isTaskListComplete,
  unresolvedBlockers,
} from '../src/exports/store/taskGraph';
import type { Task } from '../src/exports/store/types';

function task(id: number, status: Task['status'], blockedBy?: number[]): Task {
  return { id, subject: `task-${id}`, status, ...(blockedBy ? { blockedBy } : {}) };
}

describe('isTaskListComplete', () => {
  it('requires at least one visible task and every visible task completed', () => {
    expect(isTaskListComplete([])).toBe(false);
    expect(isTaskListComplete([task(1, 'deleted')])).toBe(false);
    expect(isTaskListComplete([task(1, 'completed'), task(2, 'deleted')])).toBe(true);
    expect(isTaskListComplete([task(1, 'completed'), task(2, 'pending')])).toBe(false);
  });
});

describe('detectCycle', () => {
  it('accepts a chain with no cycle', () => {
    const tasks = [task(1, 'pending'), task(2, 'pending', [1])];

    expect(detectCycle(tasks, 3, [])).toBe(false);
  });

  it('detects a cycle introduced by the proposed edge', () => {
    const tasks = [task(1, 'pending', [2]), task(2, 'pending')];

    expect(detectCycle(tasks, 2, [1])).toBe(true);
  });

  it('detects a cycle that already exists in the graph', () => {
    const tasks = [task(1, 'pending', [2]), task(2, 'pending', [1])];

    expect(detectCycle(tasks, 1, [])).toBe(true);
  });
});

describe('deriveBlocks', () => {
  it('inverts the dependency edges', () => {
    const tasks = [task(1, 'pending'), task(2, 'pending', [1]), task(3, 'pending', [1])];

    expect(deriveBlocks(tasks).get(1)).toEqual([2, 3]);
  });

  it('returns an empty map when nothing is blocked', () => {
    expect(deriveBlocks([task(1, 'pending')]).size).toBe(0);
  });
});

describe('unresolvedBlockers', () => {
  it('treats completed and deleted blockers as resolved', () => {
    const tasks = [task(1, 'completed'), task(2, 'deleted'), task(3, 'pending')];
    const dependent = task(4, 'pending', [1, 2, 3]);

    expect(unresolvedBlockers([...tasks, dependent], dependent)).toEqual([3]);
  });

  it('keeps a failed blocker unresolved so dependents stay blocked', () => {
    const blocker = task(1, 'failed');
    const dependent = task(2, 'pending', [1]);

    expect(unresolvedBlockers([blocker, dependent], dependent)).toEqual([1]);
    expect(isBlocked([blocker, dependent], dependent)).toBe(true);
  });

  it('ignores dangling references to tasks that no longer exist', () => {
    const dependent = task(2, 'pending', [99]);

    expect(unresolvedBlockers([dependent], dependent)).toEqual([]);
    expect(isBlocked([dependent], dependent)).toBe(false);
  });
});
