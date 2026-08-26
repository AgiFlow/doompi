import {
  RUNNER_LOG_STREAM_EVENT,
  type RunnerLogQueryParams,
  type RunnerLogResponse,
  type RunnerLogStreamEvent,
  runnerLogStreamUrl,
  runnerLogUrl,
} from '../src/types/webRunnerLog.ts';

/**
 * The page's half of this package's log API. The only place the cockpit talks
 * HTTP to the hub for a runner, so if the transport ever changes, it changes
 * here alone.
 */

export type RunnerLogResult = { slice: RunnerLogResponse } | { error: string };

const UNREACHABLE = 'The cockpit hub is unreachable.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one runner's log: the last N lines, or the lines matching a substring with context. */
export async function fetchRunnerLog(
  sessionId: string,
  runId: string,
  params: RunnerLogQueryParams = {},
  signal?: AbortSignal,
): Promise<RunnerLogResult> {
  let response: Response;
  try {
    response = await fetch(runnerLogUrl(sessionId, runId, params), { signal });
  } catch (error) {
    // An aborted request is the caller replacing it, not a failure to report.
    if (error instanceof DOMException && error.name === 'AbortError') return { error: '' };
    return { error: UNREACHABLE };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok && isRecord(body) && typeof body.text === 'string') {
    return { slice: body as unknown as RunnerLogResponse };
  }
  const error = isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${response.status}.`;
  return { error };
}

export interface RunnerLogFollow {
  close(): void;
}

/**
 * Follows a running log from the offset already read, so no line is missed
 * between the slice and the stream. The stream never filters; a page with a
 * query stops following and reads a filtered slice instead.
 */
export function followRunnerLog(
  sessionId: string,
  runId: string,
  from: number,
  handlers: { onEvent(event: RunnerLogStreamEvent): void; onError(): void },
): RunnerLogFollow {
  const source = new EventSource(runnerLogStreamUrl(sessionId, runId, from));
  source.addEventListener(RUNNER_LOG_STREAM_EVENT, (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse((message as MessageEvent<string>).data);
    } catch {
      return; // A truncated frame is the next one's problem, not a reason to drop the stream.
    }
    if (isRecord(parsed) && Array.isArray(parsed.lines)) handlers.onEvent(parsed as unknown as RunnerLogStreamEvent);
  });
  source.addEventListener('error', () => handlers.onError());
  return {
    close: () => source.close(),
  };
}
