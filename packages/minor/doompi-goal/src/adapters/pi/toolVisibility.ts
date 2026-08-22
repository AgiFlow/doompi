import type { ActiveGoal, GoalStatus } from '../../types/goal.ts';

const GOAL_COMPLETE = 'goal_complete';
const GOAL_BLOCKED = 'goal_blocked';
const GOAL_TOOLS = [GOAL_COMPLETE, GOAL_BLOCKED] as const;

function namesForGoal(goal: ActiveGoal | undefined): readonly string[] {
  if (!goal) return [];
  if (goal.status === 'budget_limited') return [GOAL_COMPLETE];
  return goal.status === 'active' ? GOAL_TOOLS : [];
}

function withoutGoalTools(names: readonly string[]): string[] {
  return names.filter((name) => !GOAL_TOOLS.includes(name as (typeof GOAL_TOOLS)[number]));
}

function withGoalTools(names: readonly string[], status: GoalStatus): string[] {
  const base = withoutGoalTools(names);
  if (status === 'budget_limited') return [...base, GOAL_COMPLETE];
  if (status === 'active') return [...base, ...GOAL_TOOLS];
  return base;
}

export interface ActiveToolHost {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

export interface ToolVisibilityResult {
  activeTools: string[];
  goalTools: string[];
}

/**
 * Changes only Goal-owned names in Pi's current effective tool policy. The
 * caller must bind this after registration; changing tools during factory load
 * would accidentally widen a host policy before its session exists.
 */
export function reconcileGoalTools(host: ActiveToolHost, goal: ActiveGoal | undefined): ToolVisibilityResult {
  const current = host.getActiveTools();
  const desired = namesForGoal(goal);
  const next = desired.length === 0 ? withoutGoalTools(current) : withGoalTools(current, goal?.status ?? 'paused');
  host.setActiveTools(next);
  const verified = host.getActiveTools();
  const goalTools = desired.filter((name) => verified.includes(name));
  return { activeTools: verified, goalTools };
}

export function canExecuteGoalTools(host: ActiveToolHost, goal: ActiveGoal | undefined): boolean {
  if (!goal) return false;
  const required = namesForGoal(goal);
  return required.every((name) => host.getActiveTools().includes(name));
}

export function removeGoalTools(host: ActiveToolHost): void {
  const current = host.getActiveTools();
  const next = withoutGoalTools(current);
  if (next.length !== current.length) host.setActiveTools(next);
}
