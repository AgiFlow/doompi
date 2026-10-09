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

/** Telemetry events that explain an auto-stop decision after the fact. */
export const AUTO_STOP_EVENT = {
  /** Idle, but background work is still listed; carries what it is. */
  waitingOnBackgroundWork: 'doom_autostop.waiting_on_background_work',
  /** A message was queued, so the watch stopped until the agent settles again. */
  stoodDown: 'doom_autostop.stood_down',
  /** Everything was clear and shutdown was requested. */
  shutdownRequested: 'doom_autostop.shutdown_requested',
} as const;

/** How often a long wait on background work is reported again. */
export const AUTO_STOP_REPORT_INTERVAL_MS = 60_000;
/** Longest the session waits for telemetry to flush on its way out. */
export const AUTO_STOP_TELEMETRY_FLUSH_MS = 2_000;
/** Longest list of work items or errors carried on one event. */
export const AUTO_STOP_DETAIL_MAX_LENGTH = 500;
