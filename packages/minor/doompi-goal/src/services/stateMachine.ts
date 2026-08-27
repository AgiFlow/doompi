import type { ActiveGoal, GoalExecutionState, GoalRuntimeSnapshot, GoalStatus } from '../types/goal.ts';
import { checkpointGoalActiveTime, formatDuration, formatTokenCount, normalizeTokenBudget } from './accounting.ts';
export interface GoalCreateOptions {
  id?: string;
  now?: number;
  baselineTokens?: number;
}
function createGoalId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
export function createGoal(text: string, tokenBudget?: number, options: GoalCreateOptions = {}): ActiveGoal {
  const now = options.now ?? Date.now();
  return {
    id: options.id ?? createGoalId(),
    text,
    status: 'active',
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    tokenBudget: normalizeTokenBudget(tokenBudget),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: Math.max(0, options.baselineTokens ?? 0),
    activeStartedAt: now,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
}
export function transitionGoal(goal: ActiveGoal, requestedStatus: GoalStatus, now = Date.now()): ActiveGoal {
  const status: GoalStatus =
    requestedStatus === 'active' && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget
      ? 'budget_limited'
      : requestedStatus;
  const next = { ...goal, status, updatedAt: now };
  checkpointGoalActiveTime(next, now, status === 'active');
  return next;
}
export function incrementGoal(goal: ActiveGoal, now = Date.now()): ActiveGoal {
  return { ...goal, iteration: goal.iteration + 1, updatedAt: now };
}
export function nextGoalInstance(goal: ActiveGoal, now = Date.now(), id = createGoalId()): ActiveGoal {
  return {
    ...goal,
    id,
    status: 'active',
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    activeStartedAt: now,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
    safetyResetPending: undefined,
  };
}
export function editedGoalStatus(status: GoalStatus): GoalStatus {
  return status === 'paused' || status === 'blocked' || status === 'usage_limited' ? status : 'active';
}
export function isResumableGoalStatus(status: GoalStatus): boolean {
  return status === 'paused' || status === 'blocked' || status === 'usage_limited' || status === 'budget_limited';
}
export function blocksStaleGoalToolCalls(status: GoalStatus): boolean {
  return status === 'paused' || status === 'blocked' || status === 'usage_limited' || status === 'budget_limited';
}
export function isRetainedGoalStatus(status: GoalStatus): boolean {
  return status !== 'complete';
}
export function getExecutionState(snapshot: Pick<GoalRuntimeSnapshot, 'goal'>): GoalExecutionState {
  if (!snapshot.goal) return 'dormant';
  return snapshot.goal.status === 'active' ? 'executing' : 'retained';
}
export function formatBudget(goal: Pick<ActiveGoal, 'tokensUsed' | 'tokenBudget'>): string {
  return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}
export function formatStatus(goal: ActiveGoal | undefined): string | undefined {
  if (!goal) return undefined;
  if (goal.status === 'complete') return 'complete';
  if (goal.status === 'paused') return 'paused';
  if (goal.status === 'blocked') return 'blocked';
  if (goal.status === 'usage_limited') return 'usage';
  if (goal.status === 'budget_limited') return `budget ${formatBudget(goal)}`;
  return goal.tokenBudget === undefined
    ? `active ${formatDuration(goal.timeUsedSeconds)}`
    : `active ${formatBudget(goal)}`;
}
export function goalSummary(goal: ActiveGoal): string {
  const summary = [
    `Goal: ${goal.text}`,
    `Status: ${goal.status}`,
    `Iteration: ${goal.iteration}`,
    `Automatic model responses: ${goal.automaticModelTurns}`,
    `Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
    `Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
  ];
  if (goal.safetyPauseCause)
    summary.push(
      `Safety pause: ${goal.safetyPauseCause === 'continuation_limit' ? 'automatic response limit' : 'no progress'}`,
    );
  return summary.join('\n');
}
export function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string): string | undefined {
  if (!requestedGoalId) return 'missing goal_id';
  return requestedGoalId === goal.id ? undefined : 'goal_id does not match the active goal';
}
export function isContradictoryCompletionSummary(summary: string): boolean {
  return [
    /(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/iu,
    /\bstill\s+(?:incomplete|failing|fails?)\b/iu,
    /\btests?\s+(?:still\s+)?fail(?:ing)?\b/iu,
  ].some((pattern) => pattern.test(summary));
}
export function isGoalToolAllowedForState(status: GoalStatus, tool: 'goal_complete' | 'goal_blocked'): boolean {
  return status === 'active' || (status === 'budget_limited' && tool === 'goal_complete');
}
