import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_ERROR_EVENT,
  createBrowserError,
  createBrowserTelemetryRateLimit,
  forwardedTraceContext,
  isBrowserErrorEvent,
  parseBrowserTelemetryBatch,
  readTraceContext,
  requestOperation,
  shutdownWebTelemetry,
  WEB_TELEMETRY_ROUTE,
} from '../../src/adapters/webTelemetry.ts';

afterEach(() => vi.useRealTimers());

describe('web telemetry boundaries', () => {
  it('accepts only fixed bounded browser performance events', () => {
    expect(
      parseBrowserTelemetryBatch({
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
      parseBrowserTelemetryBatch({ v: 1, events: [{ name: 'web.browser.ready', path: '/private' }] }),
    ).toBeUndefined();
    expect(parseBrowserTelemetryBatch({ v: 1, events: Array(11).fill({ name: 'web.browser.ready' }) })).toBeUndefined();
    expect(parseBrowserTelemetryBatch({ v: 1, events: [{ name: 'other.event' }] })).toBeUndefined();
  });

  it('accepts a browser error with a bounded name, message, stack, and session id', () => {
    const parsed = parseBrowserTelemetryBatch({
      v: 1,
      events: [
        {
          name: BROWSER_ERROR_EVENT,
          source: 'window_error',
          error_name: 'TypeError',
          message: 'theme.fg is not a function',
          stack: 'TypeError: theme.fg is not a function\n  at render',
          session_id: 'id-42',
        },
      ],
    });

    expect(parsed).toEqual([
      {
        name: BROWSER_ERROR_EVENT,
        source: 'window_error',
        error_name: 'TypeError',
        message: 'theme.fg is not a function',
        stack: 'TypeError: theme.fg is not a function\n  at render',
        session_id: 'id-42',
      },
    ]);
    expect(parsed !== undefined && isBrowserErrorEvent(parsed[0]!)).toBe(true);
  });

  it('rejects a browser error that is unbounded, mislabelled, or carrying extra fields', () => {
    const valid = {
      name: BROWSER_ERROR_EVENT,
      source: 'window_error',
      error_name: 'TypeError',
      message: 'boom',
    };

    expect(parseBrowserTelemetryBatch({ v: 1, events: [{ ...valid, source: 'anywhere' }] })).toBeUndefined();
    expect(parseBrowserTelemetryBatch({ v: 1, events: [{ ...valid, message: 'x'.repeat(301) }] })).toBeUndefined();
    expect(parseBrowserTelemetryBatch({ v: 1, events: [{ ...valid, stack: 'x'.repeat(801) }] })).toBeUndefined();
    expect(parseBrowserTelemetryBatch({ v: 1, events: [{ ...valid, session_id: 'a/../b' }] })).toBeUndefined();
    expect(parseBrowserTelemetryBatch({ v: 1, events: [{ ...valid, cwd: '/private' }] })).toBeUndefined();
    // One bad event rejects the batch rather than being silently skipped.
    expect(parseBrowserTelemetryBatch({ v: 1, events: [valid, { ...valid, error_name: '' }] })).toBeUndefined();
  });

  it('rebuilds a browser error so the message and stack ride the exception', () => {
    const error = createBrowserError({
      name: BROWSER_ERROR_EVENT,
      source: 'unhandled_rejection',
      error_name: 'TypeError',
      message: 'boom',
      stack: 'TypeError: boom\n  at frame',
    });

    expect(error.name).toBe('TypeError');
    expect(error.message).toBe('boom');
    expect(error.stack).toBe('TypeError: boom\n  at frame');
    expect(
      createBrowserError({
        name: BROWSER_ERROR_EVENT,
        source: 'window_error',
        error_name: 'Error',
        message: 'no stack',
      }).stack,
    ).toBe('Error: no stack');
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
