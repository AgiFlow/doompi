import { createDoomTelemetry, type DoomTelemetry, type DoomTraceContext } from '@agimon-ai/doompi-telemetry';

export const WEB_TELEMETRY_ROUTE = '/api/telemetry/browser';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const MAX_BROWSER_EVENTS = 10;
const MAX_BROWSER_COUNT = 10_000;
const MAX_REQUESTS_PER_MINUTE = 60;
export const WEB_TELEMETRY_SHUTDOWN_TIMEOUT_MS = 2000;

export const BROWSER_PERFORMANCE_EVENTS = new Set([
  'web.browser.ready',
  'web.browser.protocol_ready',
  'web.browser.session_socket_ready',
  'web.browser.reconnect',
  'web.browser.backlog',
  'web.browser.telemetry_drop',
]);

/**
 * The one name a browser failure arrives under.
 *
 * Performance events are a closed enum because their whole payload is two
 * bounded numbers. A failure carries free text, so it is admitted under a
 * single name with a fixed set of sources instead: an unbounded vocabulary of
 * event names would let a page write arbitrary tokens into the log-sink index.
 */
export const BROWSER_ERROR_EVENT = 'web.browser.error';

/** Where in the page a failure was caught. A closed set, unlike the message. */
export const BROWSER_ERROR_SOURCES = new Set(['window_error', 'unhandled_rejection', 'session_socket']);

const MAX_ERROR_NAME_LENGTH = 120;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_ERROR_STACK_LENGTH = 800;
const MAX_SESSION_ID_LENGTH = 64;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PERFORMANCE_EVENT_KEYS = new Set(['name', 'duration_ms', 'count']);
const ERROR_EVENT_KEYS = new Set(['name', 'source', 'error_name', 'message', 'stack', 'session_id']);

export interface BrowserPerformanceEvent {
  name: string;
  duration_ms?: number;
  count?: number;
}

export interface BrowserErrorEvent {
  name: typeof BROWSER_ERROR_EVENT;
  source: string;
  error_name: string;
  message: string;
  stack?: string;
  session_id?: string;
}

export type BrowserTelemetryEvent = BrowserPerformanceEvent | BrowserErrorEvent;

export function isBrowserErrorEvent(event: BrowserTelemetryEvent): event is BrowserErrorEvent {
  return event.name === BROWSER_ERROR_EVENT;
}

/**
 * Rebuilds the browser's throw as an Error so the message and stack ride the
 * record's exception fields.
 *
 * Attribute sanitisation drops anything keyed `message` or `stack`, which is
 * the correct default and the reason this cannot be passed as attributes. The
 * exception path is the one channel that carries the text, and it is only
 * reached with `includeException`.
 */
export function createBrowserError(event: BrowserErrorEvent): Error {
  const error = new Error(event.message);
  error.name = event.error_name;
  error.stack = event.stack ?? `${event.error_name}: ${event.message}`;
  return error;
}

export function createWebTelemetry(): DoomTelemetry {
  return createDoomTelemetry({
    serviceName: 'doom-web',
    packageName: '@agimon-ai/doompi-web',
    cwd: process.cwd(),
    env: process.env,
    enableLogs: true,
    enableTraces: true,
    allowFileFallback: false,
  });
}

export function readTraceContext(headers: Headers): DoomTraceContext | undefined {
  const traceparent = headers.get('traceparent')?.trim();
  return traceparent !== undefined && TRACEPARENT.test(traceparent) ? { traceparent } : undefined;
}

/** A created child wins; without a tracing backend the validated incoming parent continues unchanged. */
export function forwardedTraceContext(
  child: DoomTraceContext | undefined,
  parent: DoomTraceContext | undefined,
): DoomTraceContext | undefined {
  return child ?? parent;
}

/** Lets server teardown finish even when a telemetry backend never settles. */
export async function shutdownWebTelemetry(
  telemetry: Pick<DoomTelemetry, 'shutdown'>,
  timeoutMs = WEB_TELEMETRY_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([telemetry.shutdown(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parsePerformanceEvent(event: Record<string, unknown>): BrowserPerformanceEvent | undefined {
  if (!BROWSER_PERFORMANCE_EVENTS.has(String(event.name))) return undefined;
  if (!Object.keys(event).every((key) => PERFORMANCE_EVENT_KEYS.has(key))) return undefined;
  const duration = event.duration_ms;
  const count = event.count;
  if (
    duration !== undefined &&
    (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 600_000)
  ) {
    return undefined;
  }
  if (
    count !== undefined &&
    (!Number.isInteger(count) || (count as number) < 0 || (count as number) > MAX_BROWSER_COUNT)
  ) {
    return undefined;
  }
  return {
    name: event.name as string,
    ...(duration === undefined ? {} : { duration_ms: Math.round(duration as number) }),
    ...(count === undefined ? {} : { count: count as number }),
  };
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
}

function parseErrorEvent(event: Record<string, unknown>): BrowserErrorEvent | undefined {
  if (!Object.keys(event).every((key) => ERROR_EVENT_KEYS.has(key))) return undefined;
  const source = boundedText(event.source, 40);
  if (source === undefined || !BROWSER_ERROR_SOURCES.has(source)) return undefined;
  const errorName = boundedText(event.error_name, MAX_ERROR_NAME_LENGTH);
  const message = boundedText(event.message, MAX_ERROR_MESSAGE_LENGTH);
  if (errorName === undefined || message === undefined) return undefined;
  const stack = event.stack === undefined ? undefined : boundedText(event.stack, MAX_ERROR_STACK_LENGTH);
  if (event.stack !== undefined && stack === undefined) return undefined;
  const sessionId = event.session_id === undefined ? undefined : boundedText(event.session_id, MAX_SESSION_ID_LENGTH);
  if (event.session_id !== undefined && (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId))) {
    return undefined;
  }
  return {
    name: BROWSER_ERROR_EVENT,
    source,
    error_name: errorName,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  };
}

/** A batch is all or nothing: one malformed event rejects the request rather than being skipped. */
export function parseBrowserTelemetryBatch(value: unknown): BrowserTelemetryEvent[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const batch = value as { v?: unknown; events?: unknown };
  if (
    batch.v !== 1 ||
    !Array.isArray(batch.events) ||
    batch.events.length === 0 ||
    batch.events.length > MAX_BROWSER_EVENTS
  ) {
    return undefined;
  }
  const parsed: BrowserTelemetryEvent[] = [];
  for (const item of batch.events) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const event = item as Record<string, unknown>;
    const next = event.name === BROWSER_ERROR_EVENT ? parseErrorEvent(event) : parsePerformanceEvent(event);
    if (next === undefined) return undefined;
    parsed.push(next);
  }
  return parsed;
}

export function createBrowserTelemetryRateLimit(now: () => number = Date.now): () => boolean {
  let windowStart = now();
  let count = 0;
  return () => {
    const current = now();
    if (current - windowStart >= 60_000) {
      windowStart = current;
      count = 0;
    }
    count += 1;
    return count <= MAX_REQUESTS_PER_MINUTE;
  };
}

export function requestOperation(pathname: string): string | undefined {
  if (pathname === '/api/health' || pathname === WEB_TELEMETRY_ROUTE || !pathname.startsWith('/api/')) return undefined;
  if (pathname === '/api/session' || pathname === '/api/pi') return undefined;
  if (pathname.startsWith('/api/plugin/')) return 'web.api.package';
  if (pathname.startsWith('/api/sessions')) return 'web.api.sessions';
  if (pathname.startsWith('/api/remote')) return 'web.api.remote';
  if (pathname.startsWith('/api/settings')) return 'web.api.settings';
  if (pathname.startsWith('/api/auth')) return 'web.api.auth';
  return 'web.api.other';
}
