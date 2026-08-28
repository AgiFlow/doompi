import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserTelemetryRateLimit,
  forwardedTraceContext,
  parseBrowserPerformanceBatch,
  readTraceContext,
  requestOperation,
  shutdownWebTelemetry,
  WEB_TELEMETRY_ROUTE,
} from '../../src/adapters/webTelemetry.ts';

afterEach(() => vi.useRealTimers());

describe('web telemetry boundaries', () => {
  it('accepts only fixed bounded browser performance events', () => {
    expect(
      parseBrowserPerformanceBatch({
        v: 1,
        events: [
          { name: 'web.browser.ready', duration_ms: 12.4 },
          { name: 'web.browser.backlog', count: 3 },
        ],
      }),
    ).toEqual([
      { name: 'web.browser.ready', duration_ms: 12 },
      { name: 'web.browser.backlog', count: 3 },
    ]);
    expect(
      parseBrowserPerformanceBatch({ v: 1, events: [{ name: 'web.browser.ready', path: '/private' }] }),
    ).toBeUndefined();
    expect(
      parseBrowserPerformanceBatch({ v: 1, events: Array(11).fill({ name: 'web.browser.ready' }) }),
    ).toBeUndefined();
    expect(parseBrowserPerformanceBatch({ v: 1, events: [{ name: 'other.event' }] })).toBeUndefined();
  });

  it('validates trace context and never uses request paths as operation names', () => {
    const headers = new Headers({ traceparent: '00-11111111111111111111111111111111-2222222222222222-01' });
    expect(readTraceContext(headers)).toEqual({ traceparent: headers.get('traceparent') });
    expect(readTraceContext(new Headers({ traceparent: 'private' }))).toBeUndefined();
    expect(requestOperation('/api/sessions/private-id/restart')).toBe('web.api.sessions');
    expect(requestOperation('/assets/private.js')).toBeUndefined();
    expect(requestOperation('/api/health')).toBeUndefined();
    expect(requestOperation(WEB_TELEMETRY_ROUTE)).toBeUndefined();
  });

  it('forwards a child trace when available and otherwise preserves the validated parent', () => {
    const parent = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' };
    const child = { traceparent: '00-11111111111111111111111111111111-3333333333333333-01' };

    expect(forwardedTraceContext(child, parent)).toBe(child);
    expect(forwardedTraceContext(undefined, parent)).toBe(parent);
  });

  it('bounds telemetry shutdown at two seconds', async () => {
    vi.useFakeTimers();
    let settled = false;
    const shutdown = shutdownWebTelemetry({ shutdown: async () => await new Promise<void>(() => {}) }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds ingestion rate in fixed windows', () => {
    let now = 100;
    const accept = createBrowserTelemetryRateLimit(() => now);
    for (let request = 0; request < 60; request += 1) expect(accept()).toBe(true);
    expect(accept()).toBe(false);
    now += 60_000;
    expect(accept()).toBe(true);
  });
});
