import { useState } from 'react';

import type { MetricsReport } from '../../../../types/webMetrics';
import { MetricsReportView } from './MetricsReportView';

// Sanitized direct CLI capture from log-sink-mcp 0.29.34, 2026-09-29.
// Only metrics, no prompts, paths, session identifiers or tool arguments.
const recorded: MetricsReport = {
  generatedAt: '2026-09-29T00:23:58.946Z',
  startTime: '2026-09-22T00:23:58.904Z',
  endTime: '2026-09-29T00:23:58.946Z',
  dimension: 'model',
  period: 'week',
  bucketUnit: 'day',
  transport: 'http',
  totals: {
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
  },
  timeline: [
    {
      label: '2026-09-29',
      totalTokens: 178845,
      inputTokens: 25428,
      outputTokens: 969,
    },
  ],
  groups: [
    {
      key: 'unknown',
      totalTokens: 178845,
      inputTokens: 25428,
      outputTokens: 969,
      issueCount: 1,
      failed: false,
    },
  ],
  tools: [],
};

// Illustrative multi-day data for layout and interaction coverage, not production usage.
const example: MetricsReport = {
  ...recorded,
  totals: {
    ...recorded.totals,
    totalTokens: 840000,
    inputTokens: 180000,
    outputTokens: 42000,
    cachedTokens: 490000,
    usageEventCount: 96,
    totalRecords: 2140,
    groupCount: 3,
    issueCount: 4,
    failedGroups: 1,
  },
  timeline: [60000, 140000, 20000, 170000, 80000, 120000, 250000].map((totalTokens, index) => ({
    label: `2026-09-${23 + index}`,
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
    { name: 'bash', calls: 42, p90TotalTokens: 146000 },
    { name: 'read', calls: 91, p90TotalTokens: 83000 },
    { name: 'edit', calls: 24, p90TotalTokens: 54000 },
  ],
};
function InteractiveExample() {
  const [focus, setFocus] = useState('');
  // Local focus styling only. Network filter behavior is tested in the mounted panel.
  return <MetricsReportView report={{ ...example, focus: focus || undefined }} onFocus={setFocus} />;
}
const meta = { title: 'Log/MetricsReportView', component: MetricsReportView, tags: ['style-system'] };
export default meta;

export const RecordedSnapshot = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <MetricsReportView report={recorded} onFocus={() => undefined} onPeriodChange={() => undefined} />
    </div>
  ),
};
export const Playground = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <InteractiveExample />
    </div>
  ),
};
export const Mobile = {
  render: () => (
    <div className="w-screen max-w-sm bg-doom-bg p-4">
      <MetricsReportView report={recorded} onFocus={() => undefined} />
    </div>
  ),
};
export const ZeroUsage = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <MetricsReportView
        report={{
          ...recorded,
          totals: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            groupCount: 0,
            failedGroups: 0,
            issueCount: 0,
            usageEventCount: 0,
            totalRecords: 0,
          },
          groups: [],
          timeline: [],
          tools: [],
        }}
        onFocus={() => undefined}
      />
    </div>
  ),
};
export const OlderHub = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <MetricsReportView
        report={{
          ...recorded,
          totals: {
            ...recorded.totals,
            usageEventCount: undefined,
            totalRecords: undefined,
            cachedTokens: undefined as unknown as number,
          },
        }}
        onFocus={() => undefined}
      />
    </div>
  ),
};
export const LongSessionNames = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <MetricsReportView
        report={{
          ...example,
          dimension: 'session',
          groups: example.groups.map((group, i) => ({
            ...group,
            key: `session_hash_${i}_0123456789abcdef0123456789abcdef0123456789abcdef`,
          })),
        }}
        onFocus={() => undefined}
      />
    </div>
  ),
};
