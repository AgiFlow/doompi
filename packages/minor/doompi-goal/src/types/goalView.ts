/**
 * The goal the cockpit shows, as it travels.
 *
 * The session has no data channel of its own, so the objective reaches the
 * browser on a footer status the host already relays and replays to a
 * reattaching page. This module is both halves of that wire format: the session
 * writes it, the activity dock reads it, and neither knows the other.
 */

/** The status key the activity group keys off, distinct from the footer's terse `goal`. */
export const GOAL_VIEW_STATUS_KEY = 'doom-goal-current';

/**
 * Between the state and the objective.
 *
 * An objective may itself contain this sequence, so the split is on the first
 * occurrence rather than the last: the state is the one leading field and
 * everything after it belongs to the goal.
 */
const STATUS_SEPARATOR = ' · ';

/** Strips the colour a session may have themed a status with. */
const ANSI = /\[[0-9;]*m/gu;

/** What a reader gets out of the status line. */
export interface GoalStatusView {
  /** How the session words the goal's state, such as `active 12.4k/100k`. */
  state: string;
  /** The objective, as the goal holds it. */
  objective: string;
}

/** The status line the session publishes for the dock. */
export function formatGoalStatusView(objective: string, state: string): string {
  return `${state}${STATUS_SEPARATOR}${objective}`;
}

/**
 * Reading the status line back. Statuses reach a plugin raw, so the colour a
 * session may have added comes off here. An absent, empty, or objective-less
 * line means there is no goal to draw a row for.
 */
export function parseGoalStatusView(raw: string | undefined): GoalStatusView | undefined {
  if (raw === undefined) return undefined;
  const text = raw.replace(ANSI, '').trim();
  const cut = text.indexOf(STATUS_SEPARATOR);
  if (cut === -1) return undefined;
  const objective = text.slice(cut + STATUS_SEPARATOR.length).trim();
  return objective === '' ? undefined : { state: text.slice(0, cut).trim(), objective };
}
