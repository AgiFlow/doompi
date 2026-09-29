export const STATUS_PREFIX = 'repository-hooks';
export const FAILURE_MESSAGE_TYPE = 'repository-hook-failure';
export const CONTEXT_MESSAGE_TYPE = 'repository-hook-context';
/** A Stop hook refused the stop; its reason sends the agent back to work. */
export const STOP_BLOCK_MESSAGE_TYPE = 'repository-hook-stop-block';
export const STEER = { deliverAs: 'steer' } as const;
/** Starts a new turn on a settled agent, so a refused stop is not a silent one. */
export const FOLLOW_UP_TURN = { deliverAs: 'followUp', triggerTurn: true } as const;
/** Adds a message to a settled agent's conversation without starting a turn. */
export const NO_TURN = { triggerTurn: false } as const;
/**
 * How many stops in a row a Stop hook may refuse before the agent is left to
 * stop. A hook that never lets go would otherwise send it back forever.
 */
export const MAX_STOP_REFUSALS = 5;
/** Claude's Stop hook input field: true when the agent is already continuing because of a Stop hook. */
export const STOP_HOOK_ACTIVE_FIELD = 'stop_hook_active';
export const BLOCKED_BY_HOOK = 'Blocked by repository hook';
export const SUBAGENT_ENVIRONMENT_FLAG = 'PI_SUBAGENT_CHILD';
export const CONTEXT_SEPARATOR = '\n\n';
