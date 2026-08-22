export const GOAL_STATUSES = [
  'active',
  'queued',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type SafetyPauseCause = 'continuation_limit' | 'no_progress';
export interface ActiveGoal {
  id: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  activeStartedAt?: number;
  automaticModelTurns: number;
  toolFreeRepeatCount: number;
  lastToolFreeOutputFingerprint?: string;
  safetyPauseCause?: SafetyPauseCause;
  safetyResetPending?: boolean;
}
export type PendingQueueAction =
  | { kind: 'prioritize'; objective: string; tokenBudget?: number; displacedUsageFinalized?: boolean }
  | { kind: 'advance'; goalId: string; reason: 'complete' | 'skip'; completedText: string };
export interface GoalStateData {
  goal: ActiveGoal | null;
  queue?: ActiveGoal[];
  pendingAction?: PendingQueueAction;
}
export interface LoadedGoalState {
  goal?: ActiveGoal;
  queue: ActiveGoal[];
  pendingAction?: PendingQueueAction;
  hasExperimentalQueueState: boolean;
  source: 'none' | 'canonical' | 'legacy-goals';
  malformed: boolean;
}
export type GoalExecutionState = 'dormant' | 'executing' | 'retained';
export interface GoalRuntimeSnapshot {
  loaded: boolean;
  execution: GoalExecutionState;
  goal?: ActiveGoal;
  queue: readonly ActiveGoal[];
  pendingAction?: PendingQueueAction;
}
