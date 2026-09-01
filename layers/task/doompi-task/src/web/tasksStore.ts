import { defineSessionStore, type SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { TASKS_CHANNEL_TYPE, type WebTask, type WebTasksPayload } from '../types/webTasks.ts';

export interface TasksSession {
  tasks: WebTask[];
  rev: number;
}

export const tasks = defineSessionStore<TasksSession>({ tasks: [], rev: 0 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTask(value: unknown): WebTask | null {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.subject !== 'string') return null;
  if (!['pending', 'in_progress', 'completed', 'failed'].includes(String(value.status))) return null;
  const task: WebTask = {
    id: value.id,
    subject: value.subject,
    status: value.status as WebTask['status'],
    blockedBy: Array.isArray(value.blockedBy)
      ? value.blockedBy.filter((id): id is number => typeof id === 'number')
      : [],
  };
  if (typeof value.description === 'string') task.description = value.description;
  if (typeof value.activeForm === 'string') task.activeForm = value.activeForm;
  if (typeof value.owner === 'string') task.owner = value.owner;
  if (typeof value.updatedAt === 'string') task.updatedAt = value.updatedAt;
  if (isRecord(value.delegation)) {
    task.delegation = {};
    if (typeof value.delegation.agent === 'string') task.delegation.agent = value.delegation.agent;
    if (typeof value.delegation.state === 'string') task.delegation.state = value.delegation.state;
  }
  return task;
}

export const tasksChannel = tasks.channel<WebTasksPayload>({
  channel: TASKS_CHANNEL_TYPE,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.tasks) || typeof input.rev !== 'number') return null;
    return { tasks: input.tasks.map(parseTask).filter((task): task is WebTask => task !== null), rev: input.rev };
  },
  reduce: (_current, payload) => payload,
});

/** The fields the cockpit lets a human change on a task. */
export interface TaskEditDraft {
  subject: string;
  description: string;
  status: WebTask['status'];
}

export function taskEditDraft(task: WebTask): TaskEditDraft {
  return { subject: task.subject, description: task.description ?? '', status: task.status };
}

function changedFields(task: WebTask, draft: TaskEditDraft): string[] {
  const changes: string[] = [];
  const subject = draft.subject.trim();
  const description = draft.description.trim();
  if (subject && subject !== task.subject) changes.push(`set subject to "${subject}"`);
  if (description !== (task.description ?? '').trim()) {
    changes.push(description ? `set description to "${description}"` : 'clear the description');
  }
  if (draft.status !== task.status) changes.push(`set status to ${draft.status}`);
  return changes;
}

/**
 * The agent stays the only writer of task state, so an edit leaves the cockpit
 * as one prompt naming exactly the fields the human changed. Nothing changed
 * means nothing to send.
 */
export function taskEditInstruction(task: WebTask, draft: TaskEditDraft): string | null {
  const changes = changedFields(task, draft);
  if (changes.length === 0) return null;
  return `Update task #${task.id}: ${changes.join('; ')}. Change nothing else and keep the dependency graph valid.`;
}

export function requestTaskEdit(
  send: SessionFrameSender,
  sessionId: string,
  task: WebTask,
  draft: TaskEditDraft,
): boolean {
  const message = taskEditInstruction(task, draft);
  if (message === null) return false;
  send(sessionId, { type: 'prompt', message });
  return true;
}

/** Steering for the subagent that owns a delegated task. */
export function taskMessageInstruction(taskId: number, agent: string, message: string): string {
  return `Steer the ${agent} run working on task #${taskId} with this message, then update the task if its plan changed: ${message.trim()}`;
}

export function requestTaskMessage(
  send: SessionFrameSender,
  sessionId: string,
  taskId: number,
  agent: string,
  message: string,
): void {
  send(sessionId, { type: 'prompt', message: taskMessageInstruction(taskId, agent, message) });
}

export function requestTaskRemoval(send: SessionFrameSender, sessionId: string, taskId: number): void {
  send(sessionId, {
    type: 'prompt',
    message: `Remove task #${taskId}. Also remove or repair every dependency that references it so the remaining task graph is valid.`,
  });
}
