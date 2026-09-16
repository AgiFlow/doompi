export const DEFAULT_AUTO_STOP_DELAYS = {
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
