import type { DoomContextContribution } from '@agimon-ai/doompi-extension-contracts/context-contributions';
import type { Task } from './store/types.ts';

export const TASK_CONTEXT_CONTRIBUTION_SOURCE = '@agimon-ai/doompi-task';
export const TASK_CONTEXT_CONTRIBUTION_ID = 'active-tasks';
export const TASK_CONTEXT_CONTRIBUTION_LABEL = 'Active tasks';
export const TASK_CONTEXT_CONTRIBUTION_ORDER = 100;

interface TaskContextSnapshot {
  readonly id: number;
  readonly status: Task['status'];
  readonly subject: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly blockedBy?: readonly number[];
  readonly delegation?: {
    readonly agent: string;
    readonly state: NonNullable<Task['delegation']>['state'];
    readonly error?: string;
  };
}

function activeTaskSnapshots(tasks: readonly Task[]): TaskContextSnapshot[] {
  return tasks
    .filter((task) => task.status === 'pending' || task.status === 'in_progress' || task.status === 'failed')
    .map((task) => ({
      id: task.id,
      status: task.status,
      subject: task.subject,
      ...(task.activeForm ? { activeForm: task.activeForm } : {}),
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.blockedBy?.length ? { blockedBy: task.blockedBy } : {}),
      ...(task.delegation
        ? {
            delegation: {
              agent: task.delegation.agent,
              state: task.delegation.state,
              ...(task.delegation.result?.error ? { error: task.delegation.result.error } : {}),
            },
          }
        : {}),
    }));
}

function formatTaskSnapshots(tasks: readonly TaskContextSnapshot[]): string {
  if (tasks.length === 0) return '(no active tasks)';
  return tasks
    .map((task) => {
      const details = [
        task.activeForm ? `active: ${task.activeForm}` : undefined,
        task.owner ? `owner: ${task.owner}` : undefined,
        task.blockedBy?.length ? `blocked by: ${task.blockedBy.join(', ')}` : undefined,
        task.delegation ? `delegation: ${task.delegation.agent} (${task.delegation.state})` : undefined,
        task.delegation?.error ? `error: ${task.delegation.error}` : undefined,
      ].filter((value): value is string => Boolean(value));
      return `- #${task.id} [${task.status}] ${task.subject}${details.length > 0 ? ` | ${details.join(' | ')}` : ''}`;
    })
    .join('\n');
}

/** Builds Task's bounded, synchronous contribution from its in-memory store snapshot. */
export function createTaskContextContribution(readTasks: () => readonly Task[]): DoomContextContribution {
  return Object.freeze({
    source: TASK_CONTEXT_CONTRIBUTION_SOURCE,
    id: TASK_CONTEXT_CONTRIBUTION_ID,
    label: TASK_CONTEXT_CONTRIBUTION_LABEL,
    order: TASK_CONTEXT_CONTRIBUTION_ORDER,
    snapshot: () => formatTaskSnapshots(activeTaskSnapshots(readTasks())),
  });
}
