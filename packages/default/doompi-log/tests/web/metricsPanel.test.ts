import { renderPlugin } from '@agimon-ai/doompi-web-contracts/testing';
import { describe, expect, it, vi } from 'vitest';
import type { IssueSample, MetricsBucket, MetricsGroup, MetricsTool } from '../../src/types/webMetrics.ts';
import { GroupBars } from '../../src/web/charts/GroupBars.tsx';
import { TimelineChart } from '../../src/web/charts/TimelineChart.tsx';
import { IssuesDetail } from '../../src/web/IssuesDetail.tsx';
import { EmptyForReason, FocusNotice } from '../../src/web/MetricsNotice.tsx';
import { IssuesSection } from '../../src/web/IssuesSection.tsx';
import { MetricsReportView } from '../../src/web/MetricsReportView.tsx';
import { MetricsPanel } from '../../src/web/MetricsPanel.tsx';

/**
 * The drawn parts of the page, rendered to static markup.
 *
 * What this catches is a component that throws on a state the page can reach,
 * which the host would swallow into a blank panel. The states worth proving
 * are the degenerate ones: no buckets, one bucket, an all-zero series, and a
 * field an older hub did not send.
 */

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

const REQUEST = () => Promise.resolve(new Response('{}'));

function bucket(label: string, totalTokens: number): MetricsBucket {
  return { label, totalTokens, inputTokens: 0, outputTokens: 0 };
}

function group(key: string, totalTokens: number, issueCount = 0): MetricsGroup {
  return { key, totalTokens, inputTokens: 0, outputTokens: 0, issueCount, failed: issueCount > 0 };
}

const TOOLS: MetricsTool[] = [{ name: 'bash', calls: 929, p90TotalTokens: 90 }];

function sample(overrides: Partial<IssueSample> = {}): IssueSample {
  return {
    fingerprint: 'f1',
    occurrenceCount: 1,
    category: 'log_error',
    timestamp: '2026-09-02T01:05:07.100Z',
    level: 'warn',
    message: 'Failed to connect to pencil',
    detail: 'Failed to connect to pencil',
    tool: null,
    errorType: null,
    agentName: null,
    model: null,
    statusCode: null,
    ...overrides,
  };
}

describe('the metrics panel', () => {
  it('mounts before any report has arrived', () => {
    // First paint happens while the fetch is still in flight, so a panel that
    // needed a report to render would blank the page on every open.
    const rendered = renderPlugin(MetricsPanel, { request: REQUEST, requestWithStepUp: REQUEST });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="metrics-panel"');
    // The controls are usable before any data lands, so the reader can change
    // dimension or period while the first request is still in flight.
    expect(rendered.includes('refresh')).toBe(true);
  });
});

describe('the timeline chart', () => {
  it('names the bucket unit and points at a shorter period when there is only one', () => {
    const rendered = renderPlugin(TimelineChart, { buckets: [bucket('2026-09-02', 446)], bucketUnit: 'day' });

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('one day bucket')).toBe(true);
    expect(rendered.includes('pick a shorter period')).toBe(true);
  });

  it('says nothing about the unit when an older hub did not send one', () => {
    const rendered = renderPlugin(TimelineChart, { buckets: [bucket('2026-09-02', 446)] });

    // The bug this pins: interpolating an absent unit printed the literal
    // word 'undefined' into the caption on a real page.
    expect(rendered.includes('undefined')).toBe(false);
    expect(rendered.includes('one bucket')).toBe(true);
  });

  it('renders an all-zero series without dividing by zero', () => {
    const rendered = renderPlugin(TimelineChart, {
      buckets: [bucket('a', 0), bucket('b', 0)],
      bucketUnit: 'hour',
    });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).not.toContain('NaN');
  });

  it('renders an empty series', () => {
    expect(renderPlugin(TimelineChart, { buckets: [], bucketUnit: 'day' }).error).toBeUndefined();
  });
});

describe('the group bars', () => {
  it('marks a focused row as pressed and shows issue counts', () => {
    const rendered = renderPlugin(GroupBars, {
      groups: [group('sonnet', 300, 4), group('opus', 100)],
      focus: 'sonnet',
      onFocus: () => undefined,
    });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('aria-pressed="true"');
    expect(rendered.includes('sonnet')).toBe(true);
    expect(rendered.includes('ok')).toBe(true);
  });

  it('renders as plain rows when the caller offers no drill-down', () => {
    const rendered = renderPlugin(GroupBars, { groups: [group('sonnet', 300)] });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).not.toContain('<button');
  });
});

describe('the issues section', () => {
  it('explains why the detail is behind a click before it is opened', () => {
    const rendered = renderPlugin(IssuesSection, { tools: TOOLS });

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('show detail')).toBe(true);
    expect(rendered.includes('no issues endpoint')).toBe(true);
  });
});

describe('the report view', () => {
  const report = {
    generatedAt: '2026-09-02T01:00:00.000Z',
    dimension: 'session' as const,
    period: 'week' as const,
    bucketUnit: 'day',
    transport: 'http' as const,
    totals: {
      totalTokens: 446_016_281,
      inputTokens: 4482,
      outputTokens: 1_235_358,
      cachedTokens: 223_689_619,
      reasoningTokens: 210_867,
      groupCount: 4,
      failedGroups: 1,
      issueCount: 69,
    },
    timeline: [bucket('2026-09-02', 446_016_281)],
    groups: [group('id_10851018', 300, 5), group('id_ee555783', 100)],
    tools: TOOLS,
  };

  it('draws a whole report without throwing', () => {
    const rendered = renderPlugin(MetricsReportView, { report, onFocus: () => undefined });

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('446.0M')).toBe(true);
    expect(rendered.includes('69 issues')).toBe(true);
    expect(rendered.includes('1 of 4 sessions failed')).toBe(true);
  });

  it('says the named parts do not sum to the total', () => {
    // The defect this pins: 4.5k in and 1.2M out sat beside 446.0M looking
    // like a breakdown, while being 0.28% of it.
    const rendered = renderPlugin(MetricsReportView, { report, onFocus: () => undefined });

    expect(rendered.includes('cache reads')).toBe(true);
    expect(rendered.includes('do not sum to it')).toBe(true);
  });

  it('warns that session keys are hashed and cannot be opened', () => {
    const rendered = renderPlugin(MetricsReportView, { report, onFocus: () => undefined });

    expect(rendered.includes('hashed before export')).toBe(true);
  });

  it('labels the tool token column as a ranking hint, not a measurement', () => {
    const rendered = renderPlugin(MetricsReportView, { report, onFocus: () => undefined });

    expect(rendered.includes('call counts are exact')).toBe(true);
  });

  it('renders a field an older hub omitted as unknown rather than zero', () => {
    const stale = { ...report, totals: { ...report.totals, cachedTokens: undefined as unknown as number } };

    const rendered = renderPlugin(MetricsReportView, { report: stale, onFocus: () => undefined });

    // '0 cache reads' was on a real page while the hub simply had not sent it.
    expect(rendered.includes('0 cache reads')).toBe(false);
    expect(rendered.includes('\u2014 cache reads')).toBe(true);
  });
});

describe('the issues detail', () => {
  const view = {
    totalIssues: 69,
    uniqueIncidents: 27,
    byCategory: { log_error: 36, tool_failure: 33 },
    byTool: { bash: 25, edit: 3 },
    byErrorType: { ENOENT: 20 },
    samples: [
      sample({ occurrenceCount: 20, detail: 'spawn /Applications/Pen.app/out/mcp-server ENOENT', errorType: 'ENOENT' }),
      sample({
        fingerprint: 'f2',
        occurrenceCount: 4,
        detail: 'pi.tool_result',
        tool: 'bash',
        category: 'tool_failure',
      }),
      sample({
        fingerprint: 'f2',
        occurrenceCount: 4,
        detail: 'pi.tool_result',
        tool: 'bash',
        category: 'tool_failure',
      }),
    ],
  };

  it('ranks distinct problems by how often each happened', () => {
    const rendered = renderPlugin(IssuesDetail, { view, tools: TOOLS });

    expect(rendered.error).toBeUndefined();
    // The 20x spawn failure is the thing to fix, so it leads.
    expect(rendered.includes('20')).toBe(true);
    expect(rendered.includes('spawn /Applications/Pen.app/out/mcp-server ENOENT')).toBe(true);
    // Two incidents share a fingerprint and merge into one 8x row.
    expect(rendered.includes('2 distinct problems')).toBe(true);
  });

  it('pairs each tool failure count with its call count from the report', () => {
    const rendered = renderPlugin(IssuesDetail, { view, tools: TOOLS });

    expect(rendered.includes('of 929 calls')).toBe(true);
  });

  it('admits when a failing tool has no call count to divide by', () => {
    // The two reports scan on their own limits, so a tool can appear in the
    // issues report and not in the ranked tool rows.
    const rendered = renderPlugin(IssuesDetail, { view, tools: [] });

    expect(rendered.includes('of unknown calls')).toBe(true);
  });

  it('lists the category breakdown beside the ranked problems', () => {
    const rendered = renderPlugin(IssuesDetail, { view, tools: TOOLS });

    expect(rendered.includes('tool_failure')).toBe(true);
    expect(rendered.includes('ENOENT')).toBe(true);
  });
});

describe('the page notices', () => {
  it('names each reason the page has nothing to draw', () => {
    const cases = [
      ['no-sink', 'no log sink'],
      ['no-data', 'nothing recorded yet'],
      ['no-api', 'metrics not installed'],
    ] as const;

    for (const [reason, title] of cases) {
      const rendered = renderPlugin(EmptyForReason, { response: { unavailable: reason, detail: 'why' } });
      expect(rendered.error).toBeUndefined();
      expect(rendered.includes(title)).toBe(true);
      expect(rendered.includes('why')).toBe(true);
    }
  });

  it('says nothing when the reader narrowed nothing', () => {
    const rendered = renderPlugin(FocusNotice, {
      requested: '',
      applied: undefined,
      dimension: 'model',
      onClear: () => undefined,
    });

    expect(rendered.html).toBe('');
  });

  it('confirms a narrowing the sink echoed back', () => {
    const rendered = renderPlugin(FocusNotice, {
      requested: 'claude-opus-5',
      applied: 'claude-opus-5',
      dimension: 'model',
      onClear: () => undefined,
    });

    expect(rendered.includes('narrowed to claude-opus-5')).toBe(true);
  });

  it('refuses to claim a narrowing the sink ignored', () => {
    // Trusting the request instead of the echo would label the whole machine's
    // usage as one model's, which is the worst failure this page can have.
    const rendered = renderPlugin(FocusNotice, {
      requested: 'claude-opus-5',
      applied: undefined,
      dimension: 'model',
      onClear: () => undefined,
    });

    expect(rendered.includes('does not support narrowing by model')).toBe(true);
    expect(rendered.includes('still everything')).toBe(true);
    expect(rendered.includes('narrowed to')).toBe(false);
  });
});
