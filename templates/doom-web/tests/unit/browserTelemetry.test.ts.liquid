import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('browser performance telemetry', () => {
  it('sends a fixed batch only through the sealed HTTP transport', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { recordBrowserPerformance } = await import('../../src/web/lib/browserTelemetry.ts');

    recordBrowserPerformance({ name: 'web.browser.ready', duration_ms: 14 });
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetch).toHaveBeenCalledWith('/api/telemetry/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, events: [{ name: 'web.browser.ready', duration_ms: 14 }] }),
    });
  });

  it('bounds queued events and reports aggregate drops rather than exporting each discarded item', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { recordBrowserPerformance } = await import('../../src/web/lib/browserTelemetry.ts');

    for (let event = 0; event < 40; event += 1) {
      recordBrowserPerformance({ name: 'web.browser.reconnect', count: 1 });
    }
    await vi.advanceTimersByTimeAsync(1000);

    const body = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    const batch = JSON.parse(body as string) as { events: Array<{ name: string; count?: number }> };
    expect(batch.events).toHaveLength(10);
    expect(batch.events[0]).toEqual({ name: 'web.browser.telemetry_drop', count: 8 });
  });

  it('drops permanent client failures instead of retrying forever', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const { recordBrowserPerformance } = await import('../../src/web/lib/browserTelemetry.ts');

    recordBrowserPerformance({ name: 'web.browser.ready' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retries rate limits and network failures, then resets after success', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi
      .spyOn(sealedHttpSession, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const { recordBrowserPerformance } = await import('../../src/web/lib/browserTelemetry.ts');

    recordBrowserPerformance({ name: 'web.browser.ready' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);

    recordBrowserPerformance({ name: 'web.browser.reconnect' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('uses capped exponential backoff for retryable responses', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const { recordBrowserPerformance } = await import('../../src/web/lib/browserTelemetry.ts');

    recordBrowserPerformance({ name: 'web.browser.ready' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16_000);
    const callsBeforeCapWindow = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(callsBeforeCapWindow);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(callsBeforeCapWindow + 1);
  });
});

describe('browser error telemetry', () => {
  it('reports an uncaught error with its bounded stack and the session it happened in', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { installBrowserErrorReporting } = await import('../../src/web/lib/browserTelemetry.ts');
    const target = new EventTarget();
    const stop = installBrowserErrorReporting({ target, sessionId: () => 'session-7' });

    const thrown = new TypeError('theme.fg is not a function');
    thrown.stack = `TypeError: theme.fg is not a function\n${'  at frame\n'.repeat(200)}`;
    const event = new Event('error') as Event & { error: unknown };
    event.error = thrown;
    target.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(1000);

    const body = fetch.mock.calls[0]?.[1]?.body;
    const batch = JSON.parse(body as string) as { events: Array<Record<string, unknown>> };
    expect(batch.events[0]).toMatchObject({
      name: 'web.browser.error',
      source: 'window_error',
      error_name: 'TypeError',
      message: 'theme.fg is not a function',
      session_id: 'session-7',
    });
    const reported = batch.events[0] as { stack?: string };
    expect(reported.stack).toHaveLength(800);
    stop();
  });

  it('reports an unhandled rejection of a non-error value without inventing a stack', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { installBrowserErrorReporting } = await import('../../src/web/lib/browserTelemetry.ts');
    const target = new EventTarget();
    const stop = installBrowserErrorReporting({ target });

    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = { code: 'socket_closed' };
    target.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(1000);

    const batch = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { events: Array<Record<string, unknown>> };
    expect(batch.events[0]).toEqual({
      name: 'web.browser.error',
      source: 'unhandled_rejection',
      error_name: 'ObjectError',
      message: '{"code":"socket_closed"}',
    });
    stop();
  });

  it('stops reporting once uninstalled, so a torn-down page cannot keep posting', async () => {
    vi.useFakeTimers();
    const { sealedHttpSession } = await import('../../src/web/lib/sealedSession.ts');
    const fetch = vi.spyOn(sealedHttpSession, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { installBrowserErrorReporting } = await import('../../src/web/lib/browserTelemetry.ts');
    const target = new EventTarget();
    installBrowserErrorReporting({ target })();

    const event = new Event('error') as Event & { error: unknown };
    event.error = new Error('after teardown');
    target.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetch).not.toHaveBeenCalled();
  });
});
