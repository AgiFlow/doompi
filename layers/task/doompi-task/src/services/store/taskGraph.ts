import type { Task } from './types.ts';

const COMPLETED_STATUS: Task['status'] = 'completed';
const DELETED_STATUS: Task['status'] = 'deleted';

/** True when a non-empty list has no visible work left to finish. */
export function isTaskListComplete(taskList: readonly Task[]): boolean {
  const visible = taskList.filter((task) => task.status !== DELETED_STATUS);
  return visible.length > 0 && visible.every((task) => task.status === COMPLETED_STATUS);
}

/**
 * Would merging `newBlockedBy` into `taskId`'s dependencies introduce a cycle?
 *
 * Takes the proposed additions explicitly so the reducer can ask the question
 * before mutating anything.
 */
export function detectCycle(taskList: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
  const edges = new Map<number, number[]>();
  for (const task of taskList) {
    if (task.id === taskId) {
      edges.set(task.id, [...new Set([...(task.blockedBy ?? []), ...newBlockedBy])]);
    } else {
      edges.set(task.id, task.blockedBy ? [...task.blockedBy] : []);
    }
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const hasCycleFrom = (node: number): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) {
      if (hasCycleFrom(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of edges.keys()) {
    if (hasCycleFrom(node)) return true;
  }
  return false;
}

/** Inverse adjacency: for each task, which tasks list it in their blockedBy. */
export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
  const blocks = new Map<number, number[]>();
  for (const task of taskList) {
    for (const dep of task.blockedBy ?? []) {
      const dependents = blocks.get(dep) ?? [];
      dependents.push(task.id);
      blocks.set(dep, dependents);
    }
  }
  return blocks;
}

/**
 * Blocking dependencies of a task that are not yet resolved.
 *
 * `completed` clears a dependency; `failed` deliberately does not, so a failed
 * delegation keeps its dependents blocked instead of silently releasing work
 * that was never actually finished.
 */
export function unresolvedBlockers(taskList: readonly Task[], task: Task): number[] {
  return (task.blockedBy ?? []).filter((dep) => {
    const blocker = taskList.find((candidate) => candidate.id === dep);
    if (!blocker) return false;
    return blocker.status !== COMPLETED_STATUS && blocker.status !== DELETED_STATUS;
  });
}

export function isBlocked(taskList: readonly Task[], task: Task): boolean {
  return unresolvedBlockers(taskList, task).length > 0;
}
