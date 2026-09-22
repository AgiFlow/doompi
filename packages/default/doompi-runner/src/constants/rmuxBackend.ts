export const RMUX_BINARY_ENV = 'DOOMPI_RMUX_BINARY';
export const POLL_MS = 100;
export const LOG_DRAIN_TIMEOUT_MS = 2_000;
/**
 * Fallback interval for a missed log-completion event or a lost session.
 * The retained pane lets the sink write its marker before session cleanup.
 */
export const LOG_DRAIN_POLL_MS = 25;
export const PANE_STATE_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{session_name}';
export const PANE_PID_FORMAT = '#{pane_pid}';
export const STOP_GRACE_MS = 3_000;
export const STOP_CLOSE_TIMEOUT_MS = 1_000;
export const EXECUTABLE_MODE = 0o755;
/** The owner, group, and other execute bits, so an already runnable file is left alone. */
export const EXECUTABLE_BITS = 0o111;
export const VENDOR_DIRECTORY = 'vendor';
export const SESSION_PREFIX = 'doom-runner-';
export const OWNED_TARGET_PATTERN = /^doom-runner-[A-Za-z0-9_-]+$/;
export const SOCKET_HASH_LENGTH = 12;
export const NON_INTERACTIVE_ENV = { NO_COLOR: '1', CI: '1' };
