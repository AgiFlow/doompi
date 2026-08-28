import { sealedHttpSession } from './sealedSession.ts';

const ROUTE = '/api/telemetry/browser';
const MAX_QUEUE = 32;
const MAX_BATCH = 10;
const SEND_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

type BrowserPerformanceEventName =
  | 'web.browser.ready'
  | 'web.browser.protocol_ready'
  | 'web.browser.session_socket_ready'
  | 'web.browser.reconnect'
  | 'web.browser.backlog'
  | 'web.browser.telemetry_drop';

interface BrowserPerformanceEvent {
  name: BrowserPerformanceEventName;
  duration_ms?: number;
  count?: number;
}

const queue: BrowserPerformanceEvent[] = [];
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

export function recordBrowserPerformance(event: BrowserPerformanceEvent): void {
  const bounded: BrowserPerformanceEvent = {
    name: event.name,
    ...(event.duration_ms === undefined
      ? {}
      : { duration_ms: Math.max(0, Math.min(600_000, Math.round(event.duration_ms))) }),
    ...(event.count === undefined ? {} : { count: Math.max(0, Math.min(10_000, Math.round(event.count))) }),
  };
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    dropped += 1;
  }
  queue.push(bounded);
  schedule();
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
