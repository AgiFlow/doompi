import type { DoomToolRestriction } from '@agimon-ai/doompi-extension-contracts/tool-surface';
import type { ActiveGoal } from '../types/goal';

const GOAL_COMPLETE = 'goal_complete';
const GOAL_BLOCKED = 'goal_blocked';
const GOAL_TOOLS = [GOAL_COMPLETE, GOAL_BLOCKED] as const;

/** Goal-owned tools the model may call for this goal, if any. */
export function namesForGoal(goal: ActiveGoal | undefined): readonly string[] {
  if (!goal) return [];
  if (goal.status === 'budget_limited') return [GOAL_COMPLETE];
  return goal.status === 'active' ? GOAL_TOOLS : [];
}

/**
 * Hides every Goal-owned tool the current goal does not permit.
 *
 * The arbiter starts from the full registered inventory, so this only ever
 * removes: a permitted tool is already there and nothing has to add it back.
 */
export function goalToolRestriction(goal: ActiveGoal | undefined): DoomToolRestriction {
  const permitted = new Set(namesForGoal(goal));
  const hidden = GOAL_TOOLS.filter((name) => !permitted.has(name));
  return (incoming) => (hidden.length === 0 ? incoming : incoming.filter((name) => !hidden.includes(name as never)));
}

/**
 * True when every tool this goal needs actually reached the host.
 *
 * A goal that needs no tool, such as a paused one, is usable by definition;
 * that is the behaviour the run loop has always relied on.
 */
export function goalToolsUsable(activeTools: readonly string[], goal: ActiveGoal | undefined): boolean {
  if (!goal) return false;
  return namesForGoal(goal).every((name) => activeTools.includes(name));
}
