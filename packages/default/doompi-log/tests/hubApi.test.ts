import type { LogMetricsReport } from '@agimon-ai/log-sink-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createLogHubApi } from '../src/adapters/hubApi.ts';
import type { IssuesSource } from '../src/types/issuesSource.ts';
import type { IssuesView, MetricsReport, MetricsUnavailable } from '../src/types/webMetrics.ts';
import type { MetricsSource } from '../src/types/metricsSource.ts';

/**
 * The hub route is the whole browser-facing surface of this package, so these
 * exercise it through `fetch` rather than by calling the handler, which is what
 * the host does.
 */

function reportWith(overrides: Partial<LogMetricsReport> = {}): LogMetricsReport {
  return {
    generatedAt: new Date('2026-01-02T03:04:05.000Z'),
    groupBy: 'model',
    period: 'week',
    bucket: 'day',
    filters: {},
    timeline: [{ label: '2026-01-02', totalTokens: 300, inputTokens: 200, outputTokens: 100 }],
    totals: {
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 4000,
      reasoningOutputTokens: 12,
      groupCount: 2,
      failedGroups: 1,
      issueCount: 4,
    },
    groups: [{ key: 'sonnet', totalTokens: 300, inputTokens: 200, outputTokens: 100, issueCount: 4, failed: true }],
    tools: { returnedTools: 1, rows: [{ toolName: 'bash', invocationCount: 7, toolCallTurn: { p90TotalTokens: 90 } }] },
    ...overrides,
  } as unknown as LogMetricsReport;
}

function sourceReturning(report: LogMetricsReport, transport: 'http' | 'cli' = 'http'): MetricsSource {
  return {
    query: vi.fn().mockResolvedValue(report),
    lastTransport: () => transport,
  } as unknown as MetricsSource;
}

describe('the log hub API', () => {
  it('projects the sink report onto the wire shape the page reads', async () => {
    const source = sourceReturning(reportWith());
    const app = createLogHubApi({ source });

    const response = await app.fetch(new Request('http://hub/metrics?dimension=model&period=week'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as MetricsReport;

    expect(body.dimension).toBe('model');
    expect(body.transport).toBe('http');
    // cachedTokens is carried because it is usually the bulk of totalTokens,
    // and a page showing only in and out beside the total implies a breakdown
    // that does not add up.
    expect(body.totals).toEqual({
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 4000,
      reasoningTokens: 12,
      groupCount: 2,
      failedGroups: 1,
      issueCount: 4,
    });
    expect(body.bucketUnit).toBe('day');
    expect(body.timeline).toEqual([{ label: '2026-01-02', totalTokens: 300, inputTokens: 200, outputTokens: 100 }]);
    expect(body.groups[0]).toEqual({
      key: 'sonnet',
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
      issueCount: 4,
      failed: true,
    });
    // Calls are exact; the token figure is the turn p90 the sink attributes,
    // never a sum, which would multiply shared turns across tools.
    expect(body.groups).toHaveLength(1);
    expect(body.tools).toEqual([{ name: 'bash', calls: 7, p90TotalTokens: 90 }]);
  });

  it('asks the sink for the requested dimension and period', async () => {
    const source = sourceReturning(reportWith({ groupBy: 'session', period: 'day' }));
    const app = createLogHubApi({ source });

    await app.fetch(new Request('http://hub/metrics?dimension=session&period=day'));

    expect(source.query).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'session', period: 'day' }));
  });

  it('refuses a dimension the sink has no data for rather than querying it', async () => {
    const source = sourceReturning(reportWith());
    const app = createLogHubApi({ source });

    // 'workflow-run' is a real sink dimension, but no DoomPi package emits the
    // attribute, so the page never offers it and the route never forwards it.
    const response = await app.fetch(new Request('http://hub/metrics?dimension=workflow-run&period=week'));

    expect(response.status).toBe(400);
    expect(source.query).not.toHaveBeenCalled();
  });

  it('reports a sink that answered nothing as no-data rather than an empty chart', async () => {
    const empty = reportWith({
      timeline: [],
      groups: [],
      tools: { returnedTools: 0, rows: [] },
      totals: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        groupCount: 0,
        failedGroups: 0,
        issueCount: 0,
      },
    } as unknown as Partial<LogMetricsReport>);
    const app = createLogHubApi({ source: sourceReturning(empty) });

    const body = (await (await app.fetch(new Request('http://hub/metrics'))).json()) as MetricsUnavailable;

    expect(body.unavailable).toBe('no-data');
  });

  it('reports both transports declining as absence, not as a fault', async () => {
    const source = {
      query: vi.fn().mockRejectedValue(new Error('sink is not running')),
      lastTransport: () => undefined,
    } as unknown as MetricsSource;
    const app = createLogHubApi({ source });

    const response = await app.fetch(new Request('http://hub/metrics'));

    // A machine that has never run the sink is the ordinary case, so the page
    // gets a state it can name rather than a 500 it has to render as a crash.
    expect(response.status).toBe(200);
    const body = (await response.json()) as MetricsUnavailable;
    expect(body.unavailable).toBe('no-sink');
    expect(body.detail).toContain('sink is not running');
  });

  it('forwards a focus as the filter field that dimension uses', async () => {
    const source = sourceReturning(reportWith({ filters: { model: ['sonnet'] } } as Partial<LogMetricsReport>));
    const app = createLogHubApi({ source });

    const body = (await (
      await app.fetch(new Request('http://hub/metrics?dimension=model&period=week&focus=sonnet'))
    ).json()) as MetricsReport;

    expect(source.query).toHaveBeenCalledWith(expect.objectContaining({ filter: { model: 'sonnet' } }));
    expect(body.focus).toBe('sonnet');
  });

  it('maps the focus onto sessionId and agentName for those dimensions', async () => {
    const source = sourceReturning(reportWith({ groupBy: 'agent' } as Partial<LogMetricsReport>));
    const app = createLogHubApi({ source });

    await app.fetch(new Request('http://hub/metrics?dimension=agent&focus=reviewer'));

    expect(source.query).toHaveBeenCalledWith(expect.objectContaining({ filter: { agentName: 'reviewer' } }));
  });

  it('omits the focus when the sink did not echo it back', async () => {
    // An older daemon ignores an unknown filter and answers with everything.
    // Reporting the requested value here would label the machine's whole
    // usage as one model's, so the page is told the narrowing did not happen.
    const source = sourceReturning(reportWith({ filters: {} } as Partial<LogMetricsReport>));
    const app = createLogHubApi({ source });

    const body = (await (
      await app.fetch(new Request('http://hub/metrics?dimension=model&focus=sonnet'))
    ).json()) as MetricsReport;

    expect(body.focus).toBeUndefined();
  });

  it('accepts the ISO string both transports actually return for generatedAt', async () => {
    // LogMetricsReport types generatedAt as Date, but the HTTP and CLI
    // transports both parse JSON, so a real response carries a string. A
    // fixture built with `new Date()` hides this; production hits it always.
    const source = sourceReturning(
      reportWith({ generatedAt: '2026-01-02T03:04:05.000Z' } as unknown as Partial<LogMetricsReport>),
    );
    const app = createLogHubApi({ source });

    const response = await app.fetch(new Request('http://hub/metrics?dimension=model'));

    expect(response.status).toBe(200);
    expect(((await response.json()) as MetricsReport).generatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('still accepts a real Date, which the in-process reader returns', async () => {
    const source = sourceReturning(reportWith({ generatedAt: new Date('2026-05-06T07:08:09.000Z') }));
    const app = createLogHubApi({ source });

    const body = (await (await app.fetch(new Request('http://hub/metrics'))).json()) as MetricsReport;

    expect(body.generatedAt).toBe('2026-05-06T07:08:09.000Z');
  });

  it('serves the issue detail the metrics report cannot carry', async () => {
    const issues = {
      query: vi.fn().mockResolvedValue({
        totalIssues: 69,
        uniqueIncidents: 27,
        byCategory: { tool_failure: 33 },
        byTool: { bash: 25 },
        byErrorType: { ENOENT: 20 },
        samples: [],
      }),
    } as unknown as IssuesSource;
    const app = createLogHubApi({ source: sourceReturning(reportWith()), issues });

    const body = (await (await app.fetch(new Request('http://hub/issues'))).json()) as IssuesView;

    // byTool is the per-tool failure count; the sink's metrics tool rows have
    // an invocation count and no error field, so this is the only source of it.
    expect(body.byTool).toEqual({ bash: 25 });
    expect(body.totalIssues).toBe(69);
  });

  it('narrows the issue detail to a focused session', async () => {
    const issues = { query: vi.fn().mockResolvedValue({ samples: [] }) } as unknown as IssuesSource;
    const app = createLogHubApi({ source: sourceReturning(reportWith()), issues });

    await app.fetch(new Request('http://hub/issues?focus=id_10851018'));

    expect(issues.query).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'id_10851018' }));
  });

  it('reports a failing issues subprocess as absence, not as a fault', async () => {
    const issues = {
      query: vi.fn().mockRejectedValue(new Error('log-sink-mcp is not installed')),
    } as unknown as IssuesSource;
    const app = createLogHubApi({ source: sourceReturning(reportWith()), issues });

    const response = await app.fetch(new Request('http://hub/issues'));

    expect(response.status).toBe(200);
    expect(((await response.json()) as MetricsUnavailable).unavailable).toBe('no-sink');
  });
});
