import { RUNNER_API_BASE_PATH, SESSION_QUERY_PARAM } from '../constants/webRunnerLog';
import type { LogSlice } from './logReader';

/**
 * The runner log API, shared by this package's session-scoped routes and its
 * cockpit plugin. The two halves run in different processes, so the wire
 * vocabulary is declared here: `src/web` may reach `src/types` and nothing else on
 * the server side.
 *
 * The routes are mounted inside one session's own server, so they name a runner
 * and never a session or a path. The page addresses a session through the hub's
 * proxy parameter; the file a run writes to is read from its metadata record by
 * the server alone.
 */

/** Where this package's API is mounted; the segment after /api/plugin/. */

/** Query parameter the hub reads to pick which session server to proxy to. */

/** One runner's log, relative to the API's own mount. */
export function runnerLogPath(runId: string): string {
  return `/runners/${encodeURIComponent(runId)}/log`;
}

/**
 * The absolute URL a page fetches for one runner's log, through the hub's proxy.
 *
 * The whole query is built here, session parameter included, so a caller never
 * has to know that the URL already carries one and never appends a second '?'.
 */
export function runnerLogUrl(sessionId: string, runId: string, params: RunnerLogQueryParams = {}): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId });
  if (params.lines !== undefined) search.set(RUNNER_LOG_PARAMS.lines, String(params.lines));
  if (params.grep !== undefined && params.grep !== '') search.set(RUNNER_LOG_PARAMS.grep, params.grep);
  if (params.ignoreCase === true) search.set(RUNNER_LOG_PARAMS.ignoreCase, 'true');
  if (params.contextLines !== undefined) search.set(RUNNER_LOG_PARAMS.contextLines, String(params.contextLines));
  return `/api/sessions/${encodeURIComponent(sessionId)}/plugin/${RUNNER_API_BASE_PATH}${runnerLogPath(runId)}?${search.toString()}`;
}

/**
 * The absolute URL a page opens an EventSource on to follow one runner's log.
 *
 * `from` is the byte offset the page has already read, which the slice response
 * reports as `fileSize`. Passing it closes the gap between reading the tail and
 * opening the stream, so a line written in between is neither lost nor shown twice.
 */
export function runnerLogStreamUrl(sessionId: string, runId: string, from: number): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId, [RUNNER_LOG_PARAMS.from]: String(from) });
  return `/api/sessions/${encodeURIComponent(sessionId)}/plugin/${RUNNER_API_BASE_PATH}${runnerLogPath(runId)}/stream?${search.toString()}`;
}

/** One runner's attached screen, relative to the API's own mount. */
export function runnerScreenPath(runId: string): string {
  return `/runners/${encodeURIComponent(runId)}/screen`;
}

/**
 * The URL a page opens an EventSource on to attach to an interactive runner.
 *
 * This is not the log. The log is scrubbed of cursor movement before it is
 * written, which is what makes it worth grepping and useless to a terminal.
 * The runner's sink keeps the unscrubbed bytes beside it, and this streams
 * those, so a real terminal emulator on the page can render them.
 */
export function runnerScreenStreamUrl(sessionId: string, runId: string, from = 0): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId, [RUNNER_LOG_PARAMS.from]: String(from) });
  return `/api/sessions/${encodeURIComponent(sessionId)}/plugin/${RUNNER_API_BASE_PATH}${runnerScreenPath(runId)}/stream?${search.toString()}`;
}

/** The URL a page POSTs keystrokes to, for a runner that is waiting on input. */
export function runnerInputUrl(sessionId: string, runId: string): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId });
  return `/api/sessions/${encodeURIComponent(sessionId)}/plugin/${RUNNER_API_BASE_PATH}${runnerScreenPath(runId)}/input?${search.toString()}`;
}

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
