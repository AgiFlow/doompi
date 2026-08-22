import { canonicalizeTasks } from '../services/store/invariants.ts';
import type { Task } from '../services/store/types.ts';

export interface TaskCounts {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  failed: number;
  blocked: number;
}

export interface TaskGroups {
  inProgress: Task[];
  blocked: Task[];
  pending: Task[];
  completed: Task[];
  failed: Task[];
}

export interface TaskProjection {
  visible: Task[];
  counts: TaskCounts;
  groups: TaskGroups;
  showIds: boolean;
  hasActiveWork: boolean;
}

export function visibleTasks(tasks: readonly Task[]): Task[] {
  return canonicalizeTasks(tasks).filter((task) => task.status !== 'deleted');
}

function indexStatuses(tasks: readonly Task[]): Map<number, Task['status']> {
  return new Map(tasks.map((task) => [task.id, task.status]));
}

function hasUnresolvedBlocker(task: Task, statuses: ReadonlyMap<number, Task['status']>): boolean {
  return (
    task.blockedBy?.some((id) => {
      const status = statuses.get(id);
      return status !== undefined && status !== 'completed' && status !== 'deleted';
    }) ?? false
  );
}

/**
 * Derive all overlay-facing state in O(tasks + dependency edges).
 *
 * The id index replaces one full task-list scan per dependency, while the
 * ordered pass keeps group ordering identical to the source document.
 */
export function deriveTaskProjection(tasks: readonly Task[]): TaskProjection {
  const canonical = canonicalizeTasks(tasks);
  const statuses = indexStatuses(canonical);
  const visible: Task[] = [];
  const counts: TaskCounts = { total: 0, completed: 0, inProgress: 0, pending: 0, failed: 0, blocked: 0 };
  const groups: TaskGroups = { inProgress: [], blocked: [], pending: [], completed: [], failed: [] };
  let showIds = false;

  for (const task of canonical) {
    if (task.status === 'deleted') continue;

    visible.push(task);
    counts.total += 1;
    showIds ||= Boolean(task.blockedBy?.length);

    switch (task.status) {
      case 'in_progress':
        counts.inProgress += 1;
        groups.inProgress.push(task);
        break;
      case 'pending': {
        counts.pending += 1;
        if (hasUnresolvedBlocker(task, statuses)) {
          counts.blocked += 1;
          groups.blocked.push(task);
        } else {
          groups.pending.push(task);
        }
        break;
      }
      case 'failed':
        counts.failed += 1;
        groups.failed.push(task);
        break;
      case 'completed':
        counts.completed += 1;
        groups.completed.push(task);
        break;
    }
  }

  return { visible, counts, groups, showIds, hasActiveWork: counts.inProgress > 0 };
}

export function countTasks(tasks: readonly Task[]): TaskCounts {
  return deriveTaskProjection(tasks).counts;
}

/**
 * Group tasks for display.
 *
 * Blocked tasks split out of `pending` because a reader scanning the overlay
 * needs to know at a glance what is actually actionable right now.
 */
export function groupTasks(tasks: readonly Task[]): TaskGroups {
  return deriveTaskProjection(tasks).groups;
}

/** Ids are only worth the visual noise once dependencies are in play. */
export function shouldShowIds(tasks: readonly Task[]): boolean {
  return tasks.some((task) => task.status !== 'deleted' && Boolean(task.blockedBy?.length));
}

export function hasActiveWork(tasks: readonly Task[]): boolean {
  return tasks.some((task) => task.status === 'in_progress');
}

export interface OverlayLayout {
  visible: Task[];
  hiddenCompleted: number;
  truncatedTail: number;
}

/**
 * Choose which rows fit the overlay budget.
 *
 * Active work wins limited space: in-progress first, then failed, blocked, and
 * pending. Selected rows are always returned in source order, however, so a
 * status update does not reshuffle an otherwise unchanged overlay.
 */
export function selectOverlayLayoutFromProjection(projection: TaskProjection, budget: number): OverlayLayout {
  const { groups, visible: sourceOrder } = projection;
  const active = [...groups.inProgress, ...groups.failed, ...groups.blocked, ...groups.pending];
  if (budget <= 0) {
    return {
      visible: [],
      hiddenCompleted: groups.completed.length,
      truncatedTail: active.length,
    };
  }
  if (sourceOrder.length <= budget) {
    return { visible: sourceOrder, hiddenCompleted: 0, truncatedTail: 0 };
  }

  if (active.length <= budget) {
    const remaining = budget - active.length;
    const shownCompleted = groups.completed.slice(0, remaining);
    const selected = new Set([...active, ...shownCompleted]);
    return {
      visible: sourceOrder.filter((task) => selected.has(task)),
      hiddenCompleted: groups.completed.length - shownCompleted.length,
      truncatedTail: 0,
    };
  }

  const selected = new Set(active.slice(0, budget));
  return {
    visible: sourceOrder.filter((task) => selected.has(task)),
    hiddenCompleted: groups.completed.length,
    truncatedTail: active.length - budget,
  };
}

export function selectOverlayLayout(tasks: readonly Task[], budget: number): OverlayLayout {
  return selectOverlayLayoutFromProjection(deriveTaskProjection(tasks), budget);
}
