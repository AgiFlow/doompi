export const STATUS_PREFIX = 'repository-hooks';
export const FAILURE_MESSAGE_TYPE = 'repository-hook-failure';
export const CONTEXT_MESSAGE_TYPE = 'repository-hook-context';
/** A Stop hook refused the stop; its reason sends the agent back to work. */
export const STOP_BLOCK_MESSAGE_TYPE = 'repository-hook-stop-block';
export const STEER = { deliverAs: 'steer' } as const;
/** Starts a new turn on a settled agent, so a refused stop is not a silent one. */
export const FOLLOW_UP_TURN = { deliverAs: 'followUp', triggerTurn: true } as const;
export const BLOCKED_BY_HOOK = 'Blocked by repository hook';
export const SUBAGENT_ENVIRONMENT_FLAG = 'PI_SUBAGENT_CHILD';
export const CONTEXT_SEPARATOR = '\n\n';
