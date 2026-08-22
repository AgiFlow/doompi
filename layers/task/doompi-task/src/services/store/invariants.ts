import type { Task, TaskStatus } from './types.ts';

/**
 * Collapse a malformed snapshot to one row per task id.
 *
 * Normal writes replace tasks in place, but older or externally edited stores
 * can contain both a stale and a current copy. Prefer the copy with the newest
 * ISO update timestamp; equal or missing timestamps use the later array entry.
 * The winning row keeps the id's original position so repair does not reorder
 * an otherwise stable task list.
 */
export function canonicalizeTasks(tasks: readonly Task[]): Task[] {
  const canonical: Task[] = [];
  const indexById = new Map<number, number>();

  for (const task of tasks) {
    const existingIndex = indexById.get(task.id);
    if (existingIndex === undefined) {
      indexById.set(task.id, canonical.length);
      canonical.push(task);
      continue;
    }

    const existing = canonical[existingIndex];
    if (!existing.updatedAt || !task.updatedAt || task.updatedAt >= existing.updatedAt) {
      canonical[existingIndex] = task;
    }
  }

  return canonical;
}

/**
 * Allowed forward transitions per source status.
 *
 * `failed` is recoverable (a delegation can be retried) so it may return to
 * pending or in_progress. `completed` is one-way to `deleted`; `deleted` is a
 * terminal tombstone.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set<TaskStatus>(['in_progress', 'completed', 'failed', 'deleted']),
  in_progress: new Set<TaskStatus>(['pending', 'completed', 'failed', 'deleted']),
  failed: new Set<TaskStatus>(['pending', 'in_progress', 'completed', 'deleted']),
  completed: new Set<TaskStatus>(['deleted']),
  deleted: new Set<TaskStatus>(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}
