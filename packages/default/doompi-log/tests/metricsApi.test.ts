import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser half. What matters here is not the happy path, which is a JSON
 * parse, but the three ways this can go wrong on a real page: the hub is
 * unreachable, the caller replaced the request, and the route answered with an
 * unavailable body that is a state rather than a failure.
 */

const { sealedFetch } = vi.hoisted(() => ({ sealedFetch: vi.fn() }));
vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: sealedFetch } }));

const { fetchIssues, fetchMetrics } = await import('../src/web/metricsApi.ts');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('the metrics browser client', () => {
  beforeEach(() => {
    sealedFetch.mockReset();
  });

  it('reads through the sealed transport, never bare fetch', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ groups: [], timeline: [], tools: [] }));

    await fetchMetrics('model', 'week');

    // A plugin calling fetch directly would send plaintext to the tunnel relay.
    expect(sealedFetch).toHaveBeenCalledTimes(1);
    expect(sealedFetch.mock.calls[0]?.[0]).toContain('/api/plugin/log/metrics');
  });

  it('passes the dimension, period and focus as query parameters', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ groups: [], timeline: [], tools: [] }));

    await fetchMetrics('session', 'day', 'abc123');

    const url = String(sealedFetch.mock.calls[0]?.[0]);
    expect(url).toContain('dimension=session');
    expect(url).toContain('period=day');
    expect(url).toContain('focus=abc123');
  });

  it('omits an empty focus rather than sending a blank filter', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ groups: [], timeline: [], tools: [] }));

    await fetchMetrics('model', 'week', '');

    expect(String(sealedFetch.mock.calls[0]?.[0])).not.toContain('focus=');
  });

  it('passes an unavailable body through as a report, not as an error', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ unavailable: 'no-sink', detail: 'nothing listening' }));

    const result = await fetchMetrics('model', 'week');

    // The page needs to name which empty state it is in, so absence must not
    // be flattened into the generic error string.
    expect(result).toEqual({ report: { unavailable: 'no-sink', detail: 'nothing listening' } });
  });

  it('reports an unreachable hub', async () => {
    sealedFetch.mockRejectedValue(new TypeError('network down'));

    expect(await fetchMetrics('model', 'week')).toEqual({ error: 'The cockpit hub is unreachable.' });
  });

  it('treats an aborted request as the caller replacing it, not as a failure', async () => {
    sealedFetch.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    // An empty message so the panel leaves whatever the next request renders.
    expect(await fetchMetrics('model', 'week')).toEqual({ error: '' });
  });

  it('surfaces the route error message on a non-ok answer', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ error: "Unknown dimension 'workflow-run'." }, 400));

    expect(await fetchMetrics('model', 'week')).toEqual({ error: "Unknown dimension 'workflow-run'." });
  });

  it('reads a successful non-JSON answer as the API not being mounted', async () => {
    // A hub serving a bundle without package APIs answers this route with the
    // SPA shell: status 200, body HTML. That is an uninstalled feature, not a
    // corrupt response, and the page must be able to say so.
    sealedFetch.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    const result = await fetchMetrics('model', 'week');

    expect(result).toEqual({ report: expect.objectContaining({ unavailable: 'no-api' }) });
  });

  it('reports the status when a failed answer is not JSON either', async () => {
    sealedFetch.mockResolvedValue(new Response('bad gateway', { status: 502 }));

    expect(await fetchMetrics('model', 'week')).toEqual({ error: 'The hub answered 502.' });
  });
});

describe('the issues browser client', () => {
  beforeEach(() => {
    sealedFetch.mockReset();
  });

  it('reads the issues route and returns the view', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ totalIssues: 69, byTool: { bash: 25 } }));

    const result = await fetchIssues();

    expect(String(sealedFetch.mock.calls[0]?.[0])).toBe('/api/plugin/log/issues');
    expect(result).toEqual({ issues: { totalIssues: 69, byTool: { bash: 25 } } });
  });

  it('forwards a focused session', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({}));

    await fetchIssues('id_abc');

    expect(String(sealedFetch.mock.calls[0]?.[0])).toBe('/api/plugin/log/issues?focus=id_abc');
  });

  it('passes an unavailable body through rather than flattening it', async () => {
    sealedFetch.mockResolvedValue(jsonResponse({ unavailable: 'no-sink', detail: 'not installed' }));

    expect(await fetchIssues()).toEqual({ issues: { unavailable: 'no-sink', detail: 'not installed' } });
  });

  it('reads a successful non-JSON answer as the API not being mounted', async () => {
    sealedFetch.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    expect(await fetchIssues()).toEqual({ issues: expect.objectContaining({ unavailable: 'no-api' }) });
  });

  it('reports an unreachable hub and treats an abort as a replacement', async () => {
    sealedFetch.mockRejectedValueOnce(new TypeError('down'));
    expect(await fetchIssues()).toEqual({ error: 'The cockpit hub is unreachable.' });

    sealedFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(await fetchIssues()).toEqual({ error: '' });
  });

  it('surfaces a route error and a non-JSON failure status', async () => {
    sealedFetch.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    expect(await fetchIssues()).toEqual({ error: 'boom' });

    sealedFetch.mockResolvedValueOnce(new Response('nope', { status: 502 }));
    expect(await fetchIssues()).toEqual({ error: 'The hub answered 502.' });
  });
});
