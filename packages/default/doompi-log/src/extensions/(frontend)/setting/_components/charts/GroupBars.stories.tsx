import type { MetricsGroup } from '../../../../../types/webMetrics';
import { GroupBars } from './GroupBars';

const groups: MetricsGroup[] = [
  {
    key: 'provider/primary-model',
    totalTokens: 120000,
    inputTokens: 100000,
    outputTokens: 20000,
    issueCount: 0,
    failed: false,
  },
  {
    key: 'provider/a-long-model-name-that-needs-to-truncate-in-a-narrow-panel',
    totalTokens: 64000,
    inputTokens: 50000,
    outputTokens: 14000,
    issueCount: 12,
    failed: true,
  },
  { key: 'idle model', totalTokens: 0, inputTokens: 0, outputTokens: 0, issueCount: 0, failed: false },
];

const meta = {
  title: 'Metrics/GroupBars',
  component: GroupBars,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-6 bg-doom-bg p-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-doom-hi">Interactive groups with a selected row</h2>
        <GroupBars groups={groups} focus={groups[1]!.key} onFocus={() => undefined} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-doom-hi">Read-only groups</h2>
        <GroupBars groups={groups} />
      </section>
    </div>
  ),
};

export const Empty = {
  render: () => (
    <div className="max-w-xl bg-doom-bg p-6">
      <GroupBars groups={[]} />
    </div>
  ),
};
