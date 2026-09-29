import { renderPlugin } from '@agimon-ai/doompi-core/webTesting';
import { describe, expect, it, vi } from 'vitest';

import { GroupBars } from '../../src/extensions/(frontend)/setting/_components/charts/GroupBars';
import { TimelineChart } from '../../src/extensions/(frontend)/setting/_components/charts/TimelineChart';
import { IssuesDetail } from '../../src/extensions/(frontend)/setting/_components/IssuesDetail';
import { IssuesSection } from '../../src/extensions/(frontend)/setting/_components/IssuesSection';
import { MetricsReportView } from '../../src/extensions/(frontend)/setting/_components/MetricsReportView';
import { MetricsSummary } from '../../src/extensions/(frontend)/setting/_components/MetricsSummary';
import { ToolMetrics } from '../../src/extensions/(frontend)/setting/_components/ToolMetrics';
import type { MetricsReport, MetricsTotals } from '../../src/types/webMetrics';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

// Sanitized values from the installed LogSink CLI, not an idealized complete fixture.
const totals: MetricsTotals = {
  totalTokens: 178845,
  inputTokens: 25428,
  outputTokens: 969,
  cachedTokens: 0,
  reasoningTokens: 0,
  groupCount: 1,
  failedGroups: 0,
  issueCount: 1,
  usageEventCount: 8,
  totalRecords: 3336,
};
const recorded: MetricsReport = {
  generatedAt: '2026-09-29T00:23:58.946Z',
  startTime: '2026-09-22T00:23:58.904Z',
  endTime: '2026-09-29T00:23:58.946Z',
  dimension: 'model',
  period: 'week',
  bucketUnit: 'day',
  transport: 'http',
  totals,
  timeline: [{ label: '2026-09-29', totalTokens: 178845, inputTokens: 25428, outputTokens: 969 }],
  groups: [
    { key: 'unknown', totalTokens: 178845, inputTokens: 25428, outputTokens: 969, issueCount: 1, failed: false },
  ],
  tools: [],
};

describe('metrics visualization with sparse recorded data', () => {
  it('renders the observed snapshot without inventing attribution, tools, spend or a trend', () => {
    const result = renderPlugin(MetricsReportView, { report: recorded, onFocus: vi.fn(), onPeriodChange: vi.fn() });
    expect(result.error).toBeUndefined();
    for (const text of [
      '178.8k',
      '25.4k',
      '969',
      'Model attribution missing',
      'Unattributed',
      'No token-attributed tool calls',
      'not enough history',
      'Monetary cost is not included',
    ])
      expect(result.includes(text)).toBe(true);
    expect(result.html).toMatch(/Cache reads<\/dt><dd[^>]*>0<\/dd>/);
    expect(result.html).toMatch(/Usage events<\/dt><dd[^>]*>8<\/dd>/);
    expect(result.html).not.toContain('data-testid="metrics-group-unknown"');
    expect(result.html).not.toContain('NaN');
    expect(result.html).not.toContain('undefined');
    expect(result.includes('dominated by cache')).toBe(false);
    expect(result.includes('View hourly detail')).toBe(true);
  });

  it('does not offer a shorter period when already viewing the day', () => {
    const result = renderPlugin(MetricsReportView, {
      report: { ...recorded, period: 'day', bucketUnit: 'hour' },
      onFocus: vi.fn(),
      onPeriodChange: vi.fn(),
    });
    expect(result.includes('View hourly detail')).toBe(false);
  });

  it('renders worker and older-hub provenance without claiming a live HTTP connection', () => {
    const worker = renderPlugin(MetricsReportView, {
      report: { ...recorded, transport: 'worker', focus: 'model-alpha' },
      onFocus: vi.fn(),
    });
    expect(worker.includes('database worker')).toBe(true);
    expect(worker.includes('cannot filter issue details by model')).toBe(true);
    const old = renderPlugin(MetricsReportView, {
      report: { ...recorded, generatedAt: 'not supplied', transport: undefined },
      onFocus: vi.fn(),
    });
    expect(old.includes('transport not reported')).toBe(true);
    expect(old.includes('not supplied')).toBe(true);
    expect(old.includes('Invalid Date')).toBe(false);
  });

  it('keeps recorded zero counts distinct from absent numbers in the summary', () => {
    const zero = renderPlugin(MetricsSummary, {
      totals: { ...totals, totalTokens: 0, inputTokens: 0, outputTokens: 0, issueCount: 0 },
    });
    expect(zero.error).toBeUndefined();
    expect(zero.html).not.toContain('text-doom-yellow');
    expect(zero.includes('Not reported')).toBe(false);
    const absent = renderPlugin(MetricsSummary, { totals: { ...totals, totalTokens: Number.NaN } });
    expect(absent.includes('Not reported')).toBe(true);
    expect(absent.html).not.toContain('NaN');
  });
});

describe('ranked consumers', () => {
  it('never sends the unknown sentinel as a real model filter', () => {
    const result = renderPlugin(GroupBars, {
      groups: recorded.groups,
      totalTokens: totals.totalTokens,
      onFocus: vi.fn(),
    });
    expect(result.includes('Unattributed')).toBe(true);
    expect(result.includes('100.0% of total')).toBe(true);
    expect(result.html).not.toContain('<button');
    expect(result.html).toContain('bg-doom-yellow');
  });

  it('sorts without mutating input and retains long names outside bar backgrounds', () => {
    const groups = Object.freeze([
      { ...recorded.groups[0]!, key: 'small-consumer-with-a-long-name', totalTokens: 1 },
      { ...recorded.groups[0]!, key: 'large-consumer', totalTokens: 100 },
      { ...recorded.groups[0]!, key: 'equal-consumer', totalTokens: 100 },
    ]);
    const result = renderPlugin(GroupBars, { groups, totalTokens: 201, onFocus: vi.fn() });
    expect(result.error).toBeUndefined();
    expect(result.html.indexOf('equal-consumer')).toBeLessThan(result.html.indexOf('large-consumer'));
    expect(result.html.indexOf('large-consumer')).toBeLessThan(result.html.indexOf('small-consumer-with-a-long-name'));
    expect(groups[0]?.key).toBe('small-consumer-with-a-long-name');
  });

  it('bounds the first view while offering all returned groups', () => {
    const groups = Array.from({ length: 12 }, (_, index) => ({
      ...recorded.groups[0]!,
      key: `group-${index}`,
      totalTokens: 12 - index,
    }));
    const result = renderPlugin(GroupBars, { groups, onFocus: vi.fn() });
    expect(result.includes('Show all 12 returned groups')).toBe(true);
    expect((result.html.match(/data-testid="metrics-group-group-/g) ?? []).length).toBe(5);
  });

  it('explains empty and zero-token group series without percentages or invalid widths', () => {
    const empty = renderPlugin(GroupBars, { groups: [] });
    expect(empty.includes('No grouped usage')).toBe(true);
    const zero = renderPlugin(GroupBars, {
      groups: [{ ...recorded.groups[0]!, key: '', totalTokens: 0 }],
      totalTokens: 0,
    });
    expect(zero.error).toBeUndefined();
    expect(zero.html).not.toContain('NaN');
    expect(zero.includes('Relative token volume')).toBe(true);
  });
});

describe('timeline and tool sample semantics', () => {
  it('provides keyboard targets and exact values for a multi-bucket timeline', () => {
    const result = renderPlugin(TimelineChart, {
      buckets: [...recorded.timeline, { label: '2026-09-30', totalTokens: 1200, inputTokens: 1000, outputTokens: 200 }],
      bucketUnit: 'day',
    });
    expect(result.error).toBeUndefined();
    expect(result.html).toContain('tabindex="0"');
    expect(result.html).toContain('role="button"');
    expect(result.includes('178,845')).toBe(true);
    expect(result.includes('View exact bucket values')).toBe(true);
    expect(result.includes('Total')).toBe(true);
    expect(result.includes('Input')).toBe(true);
    expect(result.includes('Output')).toBe(true);
  });

  it('does not draw nonfinite values as full-height bars', () => {
    const result = renderPlugin(TimelineChart, {
      buckets: [
        { ...recorded.timeline[0]!, totalTokens: Number.NaN },
        { ...recorded.timeline[0]!, label: 'later', totalTokens: 100 },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.html).not.toContain('height="NaN"');
    expect(result.includes('Not reported')).toBe(true);
  });

  it('shows absence of tool attribution instead of a blank table or a claim that no tools ran', () => {
    const result = renderPlugin(ToolMetrics, { tools: [] });
    expect(result.includes('No token-attributed tool calls')).toBe(true);
    expect(result.includes('does not mean no tools ran')).toBe(true);
    expect(result.html).not.toContain('<table');
  });

  it('ranks p90 samples without mutating input or calling them tool costs', () => {
    const tools = Object.freeze([
      { name: 'read', calls: 20, p90TotalTokens: 200 },
      { name: 'bash', calls: 10, p90TotalTokens: 200 },
    ]);
    const result = renderPlugin(ToolMetrics, { tools });
    expect(result.html.indexOf('>bash<')).toBeLessThan(result.html.indexOf('>read<'));
    expect(tools[0]?.name).toBe('read');
    expect(result.includes('P90 turn tokens')).toBe(true);
    expect(result.includes('do not add these values together')).toBe(true);
  });
});

describe('issue analysis scope and empty evidence', () => {
  it('makes a broader-than-selected analysis explicit', () => {
    const result = renderPlugin(IssuesSection, {
      tools: [],
      count: 1,
      startTime: recorded.startTime,
      endTime: recorded.endTime,
      broaderScope: true,
    });
    expect(result.includes('cannot filter issue details by model')).toBe(true);
    expect(result.includes('recorded time window')).toBe(true);
    expect(result.includes('1 issue')).toBe(true);
  });

  it('distinguishes a session window from an older hub with no lower bound', () => {
    const session = renderPlugin(IssuesSection, {
      tools: [],
      focus: 'id_abc',
      startTime: recorded.startTime,
      endTime: recorded.endTime,
    });
    expect(session.includes('Filtered to this session')).toBe(true);
    const old = renderPlugin(IssuesSection, { tools: [], endTime: recorded.endTime });
    expect(old.includes('no start bound was supplied')).toBe(true);
  });

  it('does not disguise missing incident samples as a clean run', () => {
    const base = { uniqueIncidents: 0, byCategory: {}, byTool: {}, byErrorType: {}, samples: [] };
    const none = renderPlugin(IssuesDetail, { tools: [], view: { ...base, totalIssues: 0 } });
    expect(none.includes('No issues were detected')).toBe(true);
    expect(none.html).not.toContain('metrics-issues-tools');
    const missing = renderPlugin(IssuesDetail, { tools: [], view: { ...base, totalIssues: 5 } });
    expect(missing.includes('counted issues but returned no incident samples')).toBe(true);
  });
  it('surfaces a summary/incident disagreement rather than silently clearing a recorded issue', () => {
    const view = { totalIssues: 0, uniqueIncidents: 0, byCategory: {}, byTool: {}, byErrorType: {}, samples: [] };
    const different = renderPlugin(IssuesDetail, { tools: [], view, summaryCount: 1 });
    expect(different.html).toContain('data-testid="metrics-issue-count-mismatch"');
    expect(different.includes('incident analysis returned')).toBe(true);
    const plural = renderPlugin(IssuesDetail, { tools: [], view, summaryCount: 2 });
    expect(plural.includes('2 issues')).toBe(true);
    const matching = renderPlugin(IssuesDetail, { tools: [], view, summaryCount: 0 });
    expect(matching.html).not.toContain('metrics-issue-count-mismatch');
  });
});
