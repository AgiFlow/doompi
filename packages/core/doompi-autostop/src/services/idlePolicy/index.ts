import { AUTO_STOP_ACTION } from '../../constants/idlePolicy';
import type { AutoStopDecision, AutoStopDelays, SessionActivity } from './type';
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
