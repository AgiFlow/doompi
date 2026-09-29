import type { MetricsDimension, MetricsPeriod, MetricsReport } from '../../../../types/webMetrics';
import { LOG_API_BASE_PATH } from '../../../../types/webMetrics';
import { MetricsPanel } from './MetricsPanel';

// Illustrative fixtures exercise the actual generated-client path without a hub.
// The separate Recorded Snapshot story contains the observed production counters.
const report: MetricsReport = {
  generatedAt: '2026-09-29T00:23:58.946Z',
  startTime: '2026-09-22T00:23:58.904Z',
  endTime: '2026-09-29T00:23:58.946Z',
  dimension: 'model',
  period: 'week',
  bucketUnit: 'day',
  transport: 'http',
  totals: {
    totalTokens: 840000,
    inputTokens: 180000,
    outputTokens: 42000,
    cachedTokens: 490000,
    reasoningTokens: 1000,
    groupCount: 3,
    failedGroups: 1,
    issueCount: 4,
    usageEventCount: 96,
    totalRecords: 2140,
  },
  timeline: [60000, 140000, 20000, 170000, 80000, 120000, 250000].map((totalTokens, i) => ({
    label: `2026-09-${23 + i}`,
    totalTokens,
    inputTokens: Math.round((totalTokens * 3) / 14),
    outputTokens: totalTokens / 20,
  })),
  groups: [
    { key: 'model-alpha', totalTokens: 504000, inputTokens: 108000, outputTokens: 25200, issueCount: 3, failed: true },
    { key: 'model-beta', totalTokens: 252000, inputTokens: 54000, outputTokens: 12600, issueCount: 1, failed: false },
    { key: 'model-gamma', totalTokens: 84000, inputTokens: 18000, outputTokens: 4200, issueCount: 0, failed: false },
  ],
  tools: [
    { name: 'read', calls: 91, p90TotalTokens: 83000 },
    { name: 'bash', calls: 42, p90TotalTokens: 146000 },
    { name: 'edit', calls: 24, p90TotalTokens: 54000 },
  ],
};
const issueReport = {
  totalIssues: 4,
  uniqueIncidents: 1,
  byCategory: { tool_failure: 4 },
  byTool: { bash: 4 },
  byErrorType: { ETIMEDOUT: 4 },
  samples: [
    {
      fingerprint: 'illustrative-timeout',
      occurrenceCount: 4,
      category: 'tool_failure',
      timestamp: report.generatedAt,
      level: 'error',
      message: 'Tool execution timed out',
      detail: 'The build command exceeded its configured timeout.',
      tool: 'bash',
      errorType: 'ETIMEDOUT',
      agentName: null,
      model: null,
      statusCode: null,
    },
  ],
};
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, 'http://story.invalid');
  if (url.pathname.endsWith(`/plugins/${LOG_API_BASE_PATH}/issues`)) return Promise.resolve(Response.json(issueReport));
  if (!url.pathname.endsWith(`/plugins/${LOG_API_BASE_PATH}/metrics`)) return nativeFetch(input, init);
  const dimension = (url.searchParams.get('dimension') ?? 'model') as MetricsDimension;
  const period = (url.searchParams.get('period') ?? 'week') as MetricsPeriod;
  const focus = url.searchParams.get('focus') || undefined;
  const available = report.groups.map((group, index) => ({
    ...group,
    key: dimension === 'model' ? group.key : `${dimension}-${['alpha', 'beta', 'gamma'][index]}`,
  }));
  const groups = focus === undefined ? available : available.filter((group) => group.key === focus);
  const totalTokens = groups.reduce((sum, group) => sum + group.totalTokens, 0);
  const fraction = totalTokens / report.totals.totalTokens;
  const timeline =
    period === 'day'
      ? [
          {
            label: '2026-09-29 09:00',
            totalTokens: totalTokens / 2,
            inputTokens: 90000 * fraction,
            outputTokens: 21000 * fraction,
          },
          {
            label: '2026-09-29 10:00',
            totalTokens: totalTokens / 2,
            inputTokens: 90000 * fraction,
            outputTokens: 21000 * fraction,
          },
        ]
      : report.timeline.map((bucket) => ({
          ...bucket,
          totalTokens: bucket.totalTokens * fraction,
          inputTokens: Math.round(bucket.inputTokens * fraction),
          outputTokens: bucket.outputTokens * fraction,
        }));
  const answer: MetricsReport = {
    ...report,
    dimension,
    period,
    focus,
    groups,
    timeline,
    bucketUnit: period === 'day' ? 'hour' : 'day',
    totals: {
      ...report.totals,
      totalTokens,
      inputTokens: 180000 * fraction,
      outputTokens: 42000 * fraction,
      cachedTokens: 490000 * fraction,
      groupCount: groups.length,
      failedGroups: groups.filter((group) => group.failed).length,
      issueCount: groups.reduce((sum, group) => sum + group.issueCount, 0),
    },
  };
  return new Promise((resolve) => setTimeout(() => resolve(Response.json(answer)), 120));
};
const request = (input: string, init?: RequestInit): Promise<Response> => nativeFetch(input, init);
const meta = { title: 'Log/MetricsPanel', component: MetricsPanel, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <p className="mb-4 text-sm text-doom-dim">Interactive preview · illustrative metrics</p>
      <MetricsPanel request={request} requestWithStepUp={request} />
    </div>
  ),
};
export const Mobile = {
  render: () => (
    <div className="w-screen max-w-sm bg-doom-bg p-4">
      <MetricsPanel request={request} requestWithStepUp={request} />
    </div>
  ),
};
