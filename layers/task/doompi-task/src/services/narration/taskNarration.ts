import type { Task, TaskDocument } from '../store/types.ts';

/** Package-local narration sink; the Pi adapter binds it to the injected Cordis service. */
export interface TaskNarrationSink {
  narrate(text: string): void;
}

const COMPLETED_STATUS = 'completed';
const CANCELLED_STATE = 'cancelled';
const DELETED_STATUS = 'deleted';

function visibleTasks(document: TaskDocument): Task[] {
  return document.tasks.filter((task) => task.status !== DELETED_STATUS);
}

function formatTasks(prefix: string, tasks: Task[]): string {
  const entries = tasks.map((task) => `Task ${task.id}: ${task.subject}`);
  return `${prefix} ${entries.join('. ')}.`;
}

/**
 * Translate committed task-domain transitions into generic speech requests.
 * Voice remains unaware of tasks; this service owns all task-specific wording.
 */
export function narrateTaskCommit(requester: TaskNarrationSink, previous: TaskDocument, committed: TaskDocument): void {
  const previousById = new Map(previous.tasks.map((task) => [task.id, task]));
  const created = visibleTasks(committed).filter((task) => !previousById.has(task.id));
  if (created.length > 0) {
    const prefix = visibleTasks(previous).length === 0 ? 'Task list created.' : 'Task list updated.';
    requester.narrate(formatTasks(prefix, created));
  }

  for (const task of committed.tasks) {
    const prior = previousById.get(task.id);
    if (!prior) continue;
    if (prior.status !== COMPLETED_STATUS && task.status === COMPLETED_STATUS) {
      requester.narrate(`Task completed: ${task.subject}.`);
    }
    if (prior.delegation?.state !== CANCELLED_STATE && task.delegation?.state === CANCELLED_STATE) {
      requester.narrate(`Task cancelled: ${task.subject}.`);
    }
  }
}
