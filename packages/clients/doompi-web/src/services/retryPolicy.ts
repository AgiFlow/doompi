const BASE_DELAY_MS = 150;
const MAX_DELAY_MS = 4000;

/**
 * Exponential backoff for reattaching to the session socket.
 *
 * A browser reload closes the old socket and opens a new one, and the server
 * only allows one client at a time, so the first retries have to be quick
 * enough to win that handover without hammering a socket that is genuinely
 * held by someone else.
 */
export function reattachDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}
