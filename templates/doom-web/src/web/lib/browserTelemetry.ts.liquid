import { sealedHttpSession } from './sealedSession.ts';

const ROUTE = '/api/telemetry/browser';
const MAX_QUEUE = 32;
const MAX_BATCH = 10;
const SEND_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

const MAX_ERROR_NAME_LENGTH = 120;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_ERROR_STACK_LENGTH = 800;
const MAX_SESSION_ID_LENGTH = 64;

type BrowserPerformanceEventName =
  | 'web.browser.ready'
  | 'web.browser.protocol_ready'
  | 'web.browser.session_socket_ready'
  | 'web.browser.reconnect'
  | 'web.browser.backlog'
  | 'web.browser.telemetry_drop';

const BROWSER_ERROR_EVENT = 'web.browser.error';

type BrowserErrorSource = 'window_error' | 'unhandled_rejection' | 'session_socket';

interface BrowserPerformanceEvent {
  name: BrowserPerformanceEventName;
  duration_ms?: number;
  count?: number;
}

interface BrowserErrorEvent {
  name: typeof BROWSER_ERROR_EVENT;
  source: BrowserErrorSource;
  error_name: string;
  message: string;
  stack?: string;
  session_id?: string;
}

type BrowserTelemetryEvent = BrowserPerformanceEvent | BrowserErrorEvent;

const queue: BrowserTelemetryEvent[] = [];
let dropped = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;
let retryDelayMs = SEND_DELAY_MS;
const startedAt = performance.now();

function schedule(delayMs = SEND_DELAY_MS): void {
  if (timer !== undefined || sending || queue.length === 0) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flushBrowserTelemetry();
  }, delayMs);
}

export function browserReadyDuration(): number {
  return Math.max(0, performance.now() - startedAt);
}

function enqueue(event: BrowserTelemetryEvent): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    dropped += 1;
  }
  queue.push(event);
  schedule();
}

export function recordBrowserPerformance(event: BrowserPerformanceEvent): void {
  enqueue({
    name: event.name,
    ...(event.duration_ms === undefined
      ? {}
      : { duration_ms: Math.max(0, Math.min(600_000, Math.round(event.duration_ms))) }),
    ...(event.count === undefined ? {} : { count: Math.max(0, Math.min(10_000, Math.round(event.count))) }),
  });
}

/**
 * Describes a thrown value the way the server route accepts it.
 *
 * Every field is length-capped here rather than only on the server, because the
 * route rejects a whole batch on one oversized field and a page that trips that
 * loses the report it was trying to make.
 */
function describeThrown(thrown: unknown): { error_name: string; message: string; stack?: string } {
  if (thrown instanceof Error) {
    return {
      error_name: (thrown.name || 'Error').slice(0, MAX_ERROR_NAME_LENGTH),
      message: (thrown.message || 'Unknown error').slice(0, MAX_ERROR_MESSAGE_LENGTH),
      ...(typeof thrown.stack === 'string' && thrown.stack.length > 0
        ? { stack: thrown.stack.slice(0, MAX_ERROR_STACK_LENGTH) }
        : {}),
    };
  }
  const text = typeof thrown === 'string' ? thrown : safeText(thrown);
  return {
    error_name: typeof thrown === 'string' ? 'StringError' : 'ObjectError',
    message: (text || 'Unknown error').slice(0, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function safeText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return 'Unserializable error';
  }
}

export function recordBrowserError(source: BrowserErrorSource, thrown: unknown, sessionId?: string | null): void {
  const described = describeThrown(thrown);
  const session =
    typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= MAX_SESSION_ID_LENGTH
      ? sessionId
      : undefined;
  enqueue({
    name: BROWSER_ERROR_EVENT,
    source,
    ...described,
    ...(session === undefined ? {} : { session_id: session }),
  });
}

interface ErrorReportingOptions {
  target?: EventTarget;
  sessionId?: () => string | null;
}

/**
 * Reports what the cockpit throws, so a view that dies stops dying silently.
 *
 * React re-throws an uncaught render failure through `reportError`, so the
 * window listener covers the timeline going blank as well as ordinary async
 * throws. The reports are queued through the same batch, backoff, and drop
 * counter as performance events; a page that is failing repeatedly must not
 * turn into a request loop.
 */
export function installBrowserErrorReporting(options: ErrorReportingOptions = {}): () => void {
  const target = options.target ?? window;
  const sessionId = options.sessionId ?? (() => null);

  const onError = (event: Event): void => {
    const thrown = 'error' in event ? (event as ErrorEvent).error : undefined;
    const message = 'message' in event ? (event as ErrorEvent).message : undefined;
    recordBrowserError('window_error', thrown ?? message ?? 'Unknown error', sessionId());
  };
  const onRejection = (event: Event): void => {
    const reason = 'reason' in event ? (event as PromiseRejectionEvent).reason : undefined;
    recordBrowserError('unhandled_rejection', reason, sessionId());
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

export async function flushBrowserTelemetry(): Promise<void> {
  if (sending || queue.length === 0) return;
  sending = true;
  if (dropped > 0) {
    queue.unshift({ name: 'web.browser.telemetry_drop', count: Math.min(dropped, 10_000) });
    dropped = 0;
    if (queue.length > MAX_QUEUE) queue.pop();
  }
  const events = queue.splice(0, MAX_BATCH);
  let retry = false;
  try {
    const response = await sealedHttpSession.fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, events }),
    });
    retry = response.status === 429 || response.status >= 500;
  } catch {
    retry = true;
  } finally {
    if (retry) {
      for (const event of events.reverse()) queue.unshift(event);
      while (queue.length > MAX_QUEUE) {
        queue.pop();
        dropped += 1;
      }
    }
    sending = false;
    if (retry) {
      const delay = retryDelayMs;
      retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
      schedule(delay);
    } else {
      retryDelayMs = SEND_DELAY_MS;
      schedule();
    }
  }
}
