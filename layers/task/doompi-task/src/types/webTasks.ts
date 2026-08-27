/** Browser-safe task view published by the cockpit hub channel. */
export const TASKS_CHANNEL_TYPE = 'task_graph';

export type WebTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted';

export interface WebTask {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: WebTaskStatus;
  blockedBy: number[];
  owner?: string;
  updatedAt?: string;
  delegation?: {
    agent?: string;
    state?: string;
  };
}

export interface WebTasksPayload {
  tasks: WebTask[];
  rev: number;
}
