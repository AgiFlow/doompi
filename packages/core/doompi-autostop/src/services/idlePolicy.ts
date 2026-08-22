/** What the session was doing the moment the policy was asked. */
export interface SessionActivity {
  readonly hasPendingMessages: boolean;
  readonly isIdle: boolean;
}

/** How long the policy waits before each look at the session. */
export interface AutoStopDelays {
  /** Grace period after the agent settles, so a follow-up prompt still lands. */
  readonly cooldownMs: number;
  /** Gap between looks while the agent is settled but still streaming. */
  readonly recheckMs: number;
}

export const DEFAULT_AUTO_STOP_DELAYS: AutoStopDelays = {
  cooldownMs: 5_000,
  recheckMs: 100,
};

export const AUTO_STOP_ACTION = {
  /** The session has nothing left to do and can exit. */
  shutdown: 'shutdown',
  /** Look again after the returned delay. */
  recheck: 'recheck',
  /** The user is back; stop watching until the agent settles again. */
  standDown: 'stand-down',
} as const;

export type AutoStopAction = (typeof AUTO_STOP_ACTION)[keyof typeof AUTO_STOP_ACTION];

export type AutoStopDecision =
  | { readonly action: typeof AUTO_STOP_ACTION.shutdown }
  | { readonly action: typeof AUTO_STOP_ACTION.recheck; readonly delayMs: number }
  | { readonly action: typeof AUTO_STOP_ACTION.standDown };

/**
 * Taken when the agent reports it has settled.
 *
 * Settling is not enough on its own: a queued message means the session is
 * about to run again, and even an empty queue gets the cooldown so a user
 * typing their next prompt is not cut off mid-word.
 */
export function decideOnSettled(activity: SessionActivity, delays: AutoStopDelays): AutoStopDecision {
  if (activity.hasPendingMessages) return { action: AUTO_STOP_ACTION.standDown };
  return { action: AUTO_STOP_ACTION.recheck, delayMs: delays.cooldownMs };
}

/**
 * Taken when a scheduled look comes due.
 *
 * The agent can still be streaming after it settled, so a session that is not
 * yet idle is polled rather than stopped.
 */
export function decideOnRecheck(activity: SessionActivity, delays: AutoStopDelays): AutoStopDecision {
  if (activity.hasPendingMessages) return { action: AUTO_STOP_ACTION.standDown };
  if (activity.isIdle) return { action: AUTO_STOP_ACTION.shutdown };
  return { action: AUTO_STOP_ACTION.recheck, delayMs: delays.recheckMs };
}
