import type { LogSlice } from './logReader';

/**
 * The runner log API, shared by this package's session-scoped routes and its
 * cockpit plugin. The two halves run in different processes, so the wire
 * vocabulary is declared here: the browser half may reach `src/types` and
 * nothing else on the server side.
 *
 * Where the routes live is not here. That is `src/types/apiRoutes`, which both
 * halves read, and the generated client turns into the URLs the page addresses.
 * The file a run writes to is still read from its metadata record by the server
 * alone.
 */

/**
 * One chunk of an attached pane's output.
 *
 * Base64 because these are terminal bytes, escape sequences and all, and a
 * server-sent event is a line-oriented text frame that would mangle them.
 */
export interface RunnerScreenEvent {
  chunk: string;
  /** Byte offset just past this chunk, so a reconnect resumes rather than replays. */
  offset?: number;
  /** Set once the runner exits, so the page can stop watching. */
  ended?: boolean;
}

/** The body of a keystroke POST. Text, not key codes: the pane wants bytes. */
export interface RunnerInputRequest {
  text: string;
}

/** The named SSE event carrying a RunnerScreenEvent payload. */

/**
 * A log request as query parameters. `grep` is a literal substring, not a
 * regular expression, because that is what the reader matches; `lines` bounds
 * the answer to the last N lines of whatever survived the filter.
 */
export interface RunnerLogQueryParams {
  lines?: number;
  grep?: string;
  ignoreCase?: boolean;
  contextLines?: number;
}

/** The slice the log route answers with, plus which runner it came from. */
export interface RunnerLogResponse extends LogSlice {
  runId: string;
  /** True while the runner is still writing, so the page knows following is worth offering. */
  running: boolean;
}

/**
 * One server-sent event on the follow stream: the lines appended since the last
 * one. The stream never filters: a page that sets a query stops following and
 * reads a filtered slice instead, because grep with context is a whole-file
 * answer and cannot be assembled from a chunk at a time.
 */
export interface RunnerLogStreamEvent {
  /** Appended lines, in order; empty when the event only reports the runner ending. */
  lines: string[];
  /**
   * Byte offset just past the last line in this event.
   *
   * A follower that loses the stream resumes here. Without it the page could
   * only fall back to the offset its last slice reported, which every line
   * delivered since has already moved past, so a reconnect would replay them.
   */
  offset?: number;
  /** Set once the runner exits, so the page can stop following without polling the run list. */
  ended?: boolean;
}

/** The named SSE event carrying a RunnerLogStreamEvent payload. */

/**
 * The named SSE event that carries nothing.
 *
 * A runner can be alive and silent for minutes, which on the wire is
 * indistinguishable from a connection that died. This is sent on a timer so
 * the socket keeps proving itself. Readers that only listen for `append`
 * ignore it, which is what makes it safe to add.
 */

/** Query parameter names, shared so the page and the route cannot drift apart. */
export const RUNNER_LOG_PARAMS = {
  lines: 'lines',
  grep: 'grep',
  ignoreCase: 'ignoreCase',
  contextLines: 'contextLines',
  from: 'from',
} as const;
