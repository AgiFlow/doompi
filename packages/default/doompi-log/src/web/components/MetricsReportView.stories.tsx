/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The report is typed as MetricsReport rather than left inferred, so a change
 * to the wire contract breaks this story instead of drawing stale fields.
 */
import type { MetricsReport } from '../../types/webMetrics.ts';
import { MetricsReportView } from './MetricsReportView.tsx';

const report: MetricsReport = {
  generatedAt: '2025-06-04 09:12',
  dimension: 'model',
  period: 'week',
  bucketUnit: 'day',
  transport: 'http',
  totals: {
    totalTokens: 48_240_000,
    inputTokens: 312_400,
    outputTokens: 96_800,
    cachedTokens: 47_610_000,
    reasoningTokens: 12_800,
    groupCount: 4,
    failedGroups: 1,
    issueCount: 23,
  },
  timeline: [
    { label: '2025-05-29', totalTokens: 4_120_000, inputTokens: 41_000, outputTokens: 12_400 },
    { label: '2025-05-30', totalTokens: 9_480_000, inputTokens: 62_800, outputTokens: 18_900 },
    { label: '2025-05-31', totalTokens: 1_240_000, inputTokens: 11_200, outputTokens: 3_400 },
    { label: '2025-06-01', totalTokens: 780_000, inputTokens: 7_900, outputTokens: 2_100 },
    { label: '2025-06-02', totalTokens: 12_900_000, inputTokens: 88_300, outputTokens: 27_600 },
    { label: '2025-06-03', totalTokens: 11_460_000, inputTokens: 71_500, outputTokens: 21_300 },
    { label: '2025-06-04', totalTokens: 8_260_000, inputTokens: 29_700, outputTokens: 11_100 },
  ],
  groups: [
    {
      key: 'claude-sonnet-4-5',
      totalTokens: 31_900_000,
      inputTokens: 198_400,
      outputTokens: 61_200,
      issueCount: 14,
      failed: false,
    },
    {
      key: 'gpt-5-codex',
      totalTokens: 12_140_000,
      inputTokens: 79_600,
      outputTokens: 24_800,
      issueCount: 9,
      failed: true,
    },
    {
      key: 'claude-haiku-4-5',
      totalTokens: 3_820_000,
      inputTokens: 28_100,
      outputTokens: 9_400,
      issueCount: 0,
      failed: false,
    },
    {
      key: 'gemini-2-5-pro',
      totalTokens: 380_000,
      inputTokens: 6_300,
      outputTokens: 1_400,
      issueCount: 0,
      failed: false,
    },
  ],
  tools: [
    { name: 'read', calls: 1006, p90TotalTokens: 325_900 },
    { name: 'bash', calls: 742, p90TotalTokens: 411_200 },
    { name: 'edit', calls: 388, p90TotalTokens: 298_700 },
    { name: 'grep', calls: 214, p90TotalTokens: 187_400 },
    { name: 'spawn_subagent', calls: 46, p90TotalTokens: 902_100 },
    { name: 'write', calls: 31, p90TotalTokens: 96_800 },
  ],
};

/** The degenerate shape the sink answers with on a short history: one bucket, one group. */
const singleBucket: MetricsReport = {
  ...report,
  dimension: 'session',
  period: 'day',
  bucketUnit: 'hour',
  focus: '9f2c41ae',
  transport: 'cli',
  totals: {
    totalTokens: 214_000,
    inputTokens: 3_100,
    outputTokens: 940,
    cachedTokens: 209_800,
    reasoningTokens: 0,
    groupCount: 1,
    failedGroups: 0,
    issueCount: 0,
  },
  timeline: [{ label: '2025-06-04 09:00', totalTokens: 214_000, inputTokens: 3_100, outputTokens: 940 }],
  groups: [
    { key: '9f2c41ae', totalTokens: 214_000, inputTokens: 3_100, outputTokens: 940, issueCount: 0, failed: false },
  ],
  tools: [{ name: 'read', calls: 12, p90TotalTokens: 41_200 }],
};

const meta = {
  title: 'Log/MetricsReportView',
  component: MetricsReportView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a week by model, with issues</span>
        <MetricsReportView report={report} onFocus={() => undefined} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          one bucket · session dimension · narrowed
        </span>
        <MetricsReportView report={singleBucket} onFocus={() => undefined} />
      </div>
    </div>
  ),
};
