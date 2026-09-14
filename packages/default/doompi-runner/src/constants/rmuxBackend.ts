export const RMUX_BINARY_ENV = 'DOOMPI_RMUX_BINARY';
export const POLL_MS = 100;
export const LOG_DRAIN_TIMEOUT_MS = 2_000;
/**
 * How long a drain waits on the sink's own marker before asking the server
 * whether the session it was piped from is still there.
 *
 * The marker is watched for, not polled, so this is only the interval at which
 * a sink that died without writing one is noticed.
 */
export const LOG_DRAIN_POLL_MS = 250;
export const PANE_STATE_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{session_name}';
export const PANE_PID_FORMAT = '#{pane_pid}';
export const STOP_GRACE_MS = 3_000;
export const STOP_CLOSE_TIMEOUT_MS = 1_000;
export const EXECUTABLE_MODE = 0o755;
export const SESSION_PREFIX = 'doom-runner-';
export const OWNED_TARGET_PATTERN = /^doom-runner-[A-Za-z0-9_-]+$/;
export const SOCKET_HASH_LENGTH = 12;
export const NON_INTERACTIVE_ENV = { NO_COLOR: '1', CI: '1' };
