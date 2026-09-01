import type { LogSlice } from './logReader.ts';

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
export const RUNNER_API_BASE_PATH = 'runner';

/** Query parameter the hub reads to pick which session server to proxy to. */
export const SESSION_QUERY_PARAM = 'session';

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
  return `/api/plugin/${RUNNER_API_BASE_PATH}${runnerLogPath(runId)}?${search.toString()}`;
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
  return `/api/plugin/${RUNNER_API_BASE_PATH}${runnerLogPath(runId)}/stream?${search.toString()}`;
}

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
  /** Set once the runner exits, so the page can stop following without polling the run list. */
  ended?: boolean;
}

/** The named SSE event carrying a RunnerLogStreamEvent payload. */
export const RUNNER_LOG_STREAM_EVENT = 'append';

/** Query parameter names, shared so the page and the route cannot drift apart. */
export const RUNNER_LOG_PARAMS = {
  lines: 'lines',
  grep: 'grep',
  ignoreCase: 'ignoreCase',
  contextLines: 'contextLines',
  from: 'from',
} as const;
