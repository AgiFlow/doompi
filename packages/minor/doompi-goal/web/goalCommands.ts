import { MAX_OBJECTIVE_LENGTH } from '../src/types/goal.ts';

/**
 * The slash commands the goal group sends, built in one place.
 *
 * The cockpit drives the goal through the same `/goal` verbs the terminal does
 * rather than through an API of its own, so an edit made here and an edit typed
 * there are one operation. That makes the shape of the command the contract,
 * and this is where it is kept honest: Pi tokenizes a command on whitespace and
 * rejoins on single spaces, so a multi-line objective typed into a textarea
 * would arrive collapsed. Collapsing it here means what the dialog previews is
 * what the goal ends up holding.
 *
 * One thing this cannot smooth over: Pi's tokenizer also strips quotes, so an
 * objective written with them loses them, exactly as it would if it were typed
 * after /goal in the terminal.
 */

export const CLEAR_GOAL_COMMAND = '/goal clear';

/** Whitespace as Pi's tokenizer sees it: any run of it separates two tokens. */
const WHITESPACE = /\s+/gu;

/** What the session's parseTokenBudget accepts: a count, optionally in thousands or millions. */
const TOKEN_BUDGET = /^\d+(?:\.\d+)?[km]?$/iu;

/**
 * The objective as the goal will hold it, or undefined when there is nothing
 * sendable. Repeated and surrounding whitespace goes the way Pi would take it
 * anyway, and an over-long one is refused here rather than after a round trip.
 */
export function normalizeObjective(objective: string): string | undefined {
  const collapsed = objective.trim().replaceAll(WHITESPACE, ' ');
  return collapsed === '' || collapsed.length > MAX_OBJECTIVE_LENGTH ? undefined : collapsed;
}

/**
 * The `/goal edit` a save sends, or undefined while the form cannot make one.
 *
 * A blank budget omits `--tokens`, which is what leaves the goal's current
 * budget alone: the session writes a budget only when the flag is present.
 */
/**
 * The budget out of a state line, for the edit form's placeholder.
 *
 * The session words a budgeted goal as `used/budget` and an unbudgeted one
 * without a slash, and it abbreviates both the way `--tokens` reads them back,
 * so the tail of that line is already a value the command accepts.
 */
export function budgetHintOf(state: string): string {
  const cut = state.indexOf('/');
  return cut === -1 ? '' : state.slice(cut + 1).trim();
}

export function editGoalCommand(objective: string, budget: string): string | undefined {
  const text = normalizeObjective(objective);
  if (text === undefined) return undefined;
  const tokens = budget.trim();
  if (tokens === '') return `/goal edit ${text}`;
  return TOKEN_BUDGET.test(tokens) ? `/goal edit --tokens ${tokens} ${text}` : undefined;
}
