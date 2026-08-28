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

export interface BrowserPerformanceEvent {
  name: string;
  duration_ms?: number;
  count?: number;
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

export function parseBrowserPerformanceBatch(value: unknown): BrowserPerformanceEvent[] | undefined {
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
  const parsed: BrowserPerformanceEvent[] = [];
  for (const item of batch.events) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const event = item as Record<string, unknown>;
    if (!BROWSER_PERFORMANCE_EVENTS.has(String(event.name))) return undefined;
    if (!Object.keys(event).every((key) => key === 'name' || key === 'duration_ms' || key === 'count'))
      return undefined;
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
    parsed.push({
      name: event.name as string,
      ...(duration === undefined ? {} : { duration_ms: Math.round(duration as number) }),
      ...(count === undefined ? {} : { count: count as number }),
    });
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
