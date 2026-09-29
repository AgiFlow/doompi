import { MetricsSummary } from './MetricsSummary';

const meta = { title: 'Log/MetricsSummary', component: MetricsSummary, tags: ['style-system'] };
export default meta;

// Bounded LogSink CLI capture, 2026-09-29. No prompts, paths or identifiers.
export const RecordedSnapshot = {
  render: () => (
    <div className="@container w-screen max-w-5xl bg-doom-bg p-6">
      <MetricsSummary
        totals={{
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
        }}
      />
    </div>
  ),
};
export const Playground = {
  render: () => (
    <div className="@container w-screen max-w-5xl bg-doom-bg p-6">
      <MetricsSummary
        totals={{
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          groupCount: 0,
          failedGroups: 0,
          issueCount: 0,
        }}
      />
    </div>
  ),
};
