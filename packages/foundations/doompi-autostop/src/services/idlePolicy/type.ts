import type { AUTO_STOP_ACTION } from '../../constants/idlePolicy';
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

export type AutoStopAction = (typeof AUTO_STOP_ACTION)[keyof typeof AUTO_STOP_ACTION];

export type AutoStopDecision =
  | { readonly action: typeof AUTO_STOP_ACTION.shutdown }
  | { readonly action: typeof AUTO_STOP_ACTION.recheck; readonly delayMs: number }
  | { readonly action: typeof AUTO_STOP_ACTION.standDown };
