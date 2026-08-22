export type GoalHistoryStatus =
  | 'active'
  | 'queued'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete';

export interface GoalHistoryEntry {
  id: string;
  objective: string;
  status: GoalHistoryStatus;
  reason?: string;
  budget?: number;
  archivedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GoalHistoryTombstone {
  id: string;
  removedAt: string;
}

export interface GoalHistoryDocument {
  version: 1;
  repositoryIdentity: string;
  revision: number;
  entries: GoalHistoryEntry[];
  tombstones: GoalHistoryTombstone[];
}

export interface RepositoryIdentity {
  token: string;
  root: string;
  hash: string;
}

export interface HistoryRestart {
  historyId: string;
  goalId: string;
  objective: string;
  budget?: number;
}

export interface GoalHistoryPort {
  list(): Promise<GoalHistoryEntry[]>;
  archive(entry: GoalHistoryEntry): Promise<GoalHistoryEntry>;
  remove(id: string): Promise<void>;
  restart(id: string): Promise<HistoryRestart>;
}
