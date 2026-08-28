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
