export const GOAL_STATUSES = ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'] as const;
/**
 * The longest objective a goal may hold. A constraint on the text itself rather
 * than on the command that sets it, so the parser, the codec, and the cockpit's
 * edit form all measure against the same number.
 */
export const MAX_OBJECTIVE_LENGTH = 4_000;
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
export interface GoalStateData {
  goal: ActiveGoal | null;
}
export interface LoadedGoalState {
  goal?: ActiveGoal;
  source: 'none' | 'canonical' | 'legacy-goals';
  malformed: boolean;
}
export type GoalExecutionState = 'dormant' | 'executing' | 'retained';
export interface GoalRuntimeSnapshot {
  loaded: boolean;
  execution: GoalExecutionState;
  goal?: ActiveGoal;
}
