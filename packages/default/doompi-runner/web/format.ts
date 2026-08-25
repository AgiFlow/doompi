/**
 * Local copy of the runtime's formatUptime (src/commands/bash/responseEnvelope.ts):
 * the web plugin may reach only src/types, so the one helper it needs lives here.
 */
export function formatRunnerUptime(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The lines a log view shows: the slice's text, then whatever the follow
 * stream appended, bounded to the newest `max`.
 *
 * A log file ends with a newline, and the reader hands its text back with that
 * newline intact, so a naive split reports one blank line more than the file
 * has. Dropping exactly one trailing empty entry keeps the count the reader
 * sees equal to the count the server reported.
 */
export function logViewLines(text: string, appended: readonly string[], max: number): string[] {
  const split = text.split('\n');
  if (split.length > 0 && split[split.length - 1] === '') split.pop();
  return [...split, ...appended].slice(-max);
}

/**
 * Whether the view is actually following a growing log.
 *
 * Three things must hold: the reader asked to follow, no query is set (a
 * filtered view is a snapshot of the whole file, which a stream cannot
 * assemble a chunk at a time), and the runner is still writing. Without the
 * last one a finished run would claim to be tailing a file nothing will ever
 * append to.
 */
export function isFollowingLive(following: boolean, filtering: boolean, running: boolean): boolean {
  return following && !filtering && running;
}
