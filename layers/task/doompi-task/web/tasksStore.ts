import { defineSessionStore, type SessionFrameSender } from '@agimon-ai/doompi-web-contracts';
import { TASKS_CHANNEL_TYPE, type WebTask, type WebTasksPayload } from '../src/types/webTasks.ts';

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

export type TaskInstructionKind = 'edit' | 'note';

export function taskInstruction(taskId: number, kind: TaskInstructionKind, instruction: string): string {
  const detail = instruction.trim();
  if (kind === 'note') {
    return `Send this note to the agent working on task #${taskId}, then update the task if needed: ${detail}`;
  }
  return `Update task #${taskId} according to this instruction. Preserve a valid dependency graph: ${detail}`;
}

export function requestTaskInstruction(
  send: SessionFrameSender,
  sessionId: string,
  taskId: number,
  kind: TaskInstructionKind,
  instruction: string,
): void {
  send(sessionId, { type: 'prompt', message: taskInstruction(taskId, kind, instruction) });
}

export function requestTaskRemoval(send: SessionFrameSender, sessionId: string, taskId: number): void {
  send(sessionId, {
    type: 'prompt',
    message: `Remove task #${taskId}. Also remove or repair every dependency that references it so the remaining task graph is valid.`,
  });
}
