import type { ActiveGoal, GoalStatus } from '../types/goal.ts';
export const GOAL_COMPLETE_TOOL = 'goal_complete' as const;
export const GOAL_BLOCKED_TOOL = 'goal_blocked' as const;
export const GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] as const;
export type GoalToolName = (typeof GOAL_TOOL_NAMES)[number];
export interface GoalCompleteInput {
  goal_id: string;
  summary: string;
}
export interface GoalBlockedInput {
  goal_id: string;
  reason: string;
  evidence: string;
  repeated_turns: number;
}
export interface ToolValidationResult {
  ok: boolean;
  reason?: string;
}
export function goalToolNamesForState(goal: ActiveGoal | undefined): GoalToolName[] {
  if (!goal) return [];
  if (goal.status === 'budget_limited') return [GOAL_COMPLETE_TOOL];
  return goal.status === 'active' ? [...GOAL_TOOL_NAMES] : [];
}
export function filterGoalTools(activeTools: readonly string[]): string[] {
  return activeTools.filter((name) => !(GOAL_TOOL_NAMES as readonly string[]).includes(name));
}
export function addGoalTools(activeTools: readonly string[], status: GoalStatus): string[] {
  const result = activeTools.filter((name) => !(GOAL_TOOL_NAMES as readonly string[]).includes(name));
  const names = status === 'budget_limited' ? [GOAL_COMPLETE_TOOL] : status === 'active' ? GOAL_TOOL_NAMES : [];
  return [...result, ...names];
}
export function validateGoalId(goal: Pick<ActiveGoal, 'id'> | undefined, goalId: unknown): ToolValidationResult {
  if (!goal) return { ok: false, reason: 'no active goal' };
  if (typeof goalId !== 'string' || !goalId.trim()) return { ok: false, reason: 'missing goal_id' };
  return goalId === goal.id ? { ok: true } : { ok: false, reason: 'goal_id does not match the active goal' };
}
export function validateCompletionInput(
  goal: ActiveGoal | undefined,
  input: Partial<GoalCompleteInput>,
): ToolValidationResult {
  const id = validateGoalId(goal, input.goal_id);
  if (!id.ok) return id;
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  return summary ? { ok: true } : { ok: false, reason: 'summary is empty' };
}
export function validateBlockedInput(
  goal: ActiveGoal | undefined,
  input: Partial<GoalBlockedInput>,
): ToolValidationResult {
  const id = validateGoalId(goal, input.goal_id);
  if (!id.ok) return id;
  if (typeof input.reason !== 'string' || !input.reason.trim()) return { ok: false, reason: 'reason is empty' };
  if (input.reason.length > 1000) return { ok: false, reason: 'reason is too long' };
  if (typeof input.evidence !== 'string' || !input.evidence.trim()) return { ok: false, reason: 'evidence is empty' };
  if (input.evidence.length > 4000) return { ok: false, reason: 'evidence is too long' };
  return typeof input.repeated_turns === 'number' && Number.isInteger(input.repeated_turns) && input.repeated_turns >= 3
    ? { ok: true }
    : { ok: false, reason: 'repeated_turns must be at least 3' };
}
