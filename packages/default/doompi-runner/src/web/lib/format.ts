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

/** A bounded log view: what to render, and what the bound left out. */
export interface LogView {
  lines: string[];
  /** Lines dropped off the top to stay within the bound. */
  hidden: number;
}

export interface LogViewOptions {
  /**
   * Drop the slice's last line because it is a fragment the follow stream will
   * deliver again, whole. Set only while following: a finished run's last line
   * may legitimately lack a newline, and dropping it would hide real output.
   */
  dropPartialTail?: boolean;
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
export function logViewLines(
  text: string,
  appended: readonly string[],
  max: number,
  options: LogViewOptions = {},
): LogView {
  const split = text.split('\n');
  if (split.length > 0 && split[split.length - 1] === '') split.pop();
  if (options.dropPartialTail === true && split.length > 0) split.pop();
  const all = [...split, ...appended];
  const lines = all.slice(-max);
  return { lines, hidden: all.length - lines.length };
}

/**
 * Absolute 1-based numbers for a tail, counted back from the last line.
 *
 * A tail is contiguous, so only its end has to be known. Grep results are not
 * contiguous and carry their own numbers from the reader instead.
 */
export function tailLineNumbers(lastLineNumber: number, count: number): number[] {
  const first = Math.max(1, lastLineNumber - count + 1);
  return Array.from({ length: count }, (_, index) => first + index);
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
