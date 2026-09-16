import { api } from '../../../../../../generated/client';
import { RUN_ID_PARAM, RUNNER_LOG_STREAM_EVENT } from '../../../../../constants/webRunnerLog';
import {
  RUNNER_LOG_PARAMS,
  type RunnerLogQueryParams,
  type RunnerLogResponse,
  type RunnerLogStreamEvent,
} from '../../../../../types/webRunnerLog';

/**
 * The page's half of this package's log API. The only place the cockpit talks
 * HTTP to the hub for a runner, so if the transport ever changes, it changes
 * here alone.
 *
 * The generated client owns every URL: a route is named, a session id selects
 * that session's own copy of the API, and the run id is a path parameter the
 * client substitutes and encodes. Nothing here spells a mount, a prefix or a
 * proxy parameter, which is what the four deleted URL builders each did by
 * hand.
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
  const result = await api.session(sessionId).log({
    params: { [RUN_ID_PARAM]: runId },
    // An unset parameter is left out rather than sent empty: the route reads a
    // missing one as its own default, and an empty grep as no filter at all.
    query: {
      [RUNNER_LOG_PARAMS.lines]: params.lines,
      [RUNNER_LOG_PARAMS.grep]: params.grep === '' ? undefined : params.grep,
      [RUNNER_LOG_PARAMS.ignoreCase]: params.ignoreCase === true ? true : undefined,
      [RUNNER_LOG_PARAMS.contextLines]: params.contextLines,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!result.ok) {
    // Status 0 is the transport never answering, which covers both a dead hub
    // and the caller replacing this request. An abort is the caller's own doing
    // and is reported as no answer rather than as a failure to show.
    if (result.status === 0) return { error: signal?.aborted === true ? '' : UNREACHABLE };
    return { error: result.error === '' ? `The hub answered ${String(result.status)}.` : result.error };
  }
  if (!isRecord(result.data) || typeof result.data.text !== 'string') {
    return { error: `The hub answered ${String(result.status)}.` };
  }
  return { slice: result.data };
}

export interface RunnerLogFollow {
  close(): void;
}

/** Attempts before a dropped stream is reported as lost rather than retried. */
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 500;

/**
 * Follows a running log from the offset already read, so no line is missed
 * between the slice and the stream. The stream never filters; a page with a
 * query stops following and reads a filtered slice instead.
 *
 * A dropped connection is retried with backoff from the offset the last event
 * reported, not from the offset the page started at, so a reconnect resumes
 * instead of replaying. The browser's own EventSource retry cannot do this:
 * it reopens the URL it was given, whose offset is stale the moment a line
 * arrives, so each of its reconnects would duplicate everything since.
 */
export function followRunnerLog(
  sessionId: string,
  runId: string,
  from: number,
  handlers: { onEvent(event: RunnerLogStreamEvent): void; onLost(): void },
): RunnerLogFollow {
  let offset = from;
  let retries = 0;
  let closed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    if (closed) return;
    const current = new EventSource(
      api
        .session(sessionId)
        .logStream.url({ params: { [RUN_ID_PARAM]: runId }, query: { [RUNNER_LOG_PARAMS.from]: offset } }),
    );
    source = current;
    current.addEventListener(RUNNER_LOG_STREAM_EVENT, (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse((message as MessageEvent<string>).data);
      } catch {
        return; // A truncated frame is the next one's problem, not a reason to drop the stream.
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.lines)) return;
      const event = parsed as unknown as RunnerLogStreamEvent;
      if (typeof event.offset === 'number') offset = event.offset;
      retries = 0;
      // The server closes after this one, and a close reaches us as an error.
      // Standing down first keeps that from looking like a dropped stream.
      if (event.ended === true) {
        closed = true;
        current.close();
      }
      handlers.onEvent(event);
    });
    current.addEventListener('error', () => {
      current.close();
      if (closed) return;
      retries += 1;
      if (retries > MAX_RETRIES) {
        handlers.onLost();
        return;
      }
      timer = setTimeout(open, RETRY_BASE_MS * 2 ** (retries - 1));
    });
  };

  open();
  return {
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      source?.close();
    },
  };
}
