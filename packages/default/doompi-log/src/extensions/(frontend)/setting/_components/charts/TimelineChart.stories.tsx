import type { MetricsBucket } from '../../../../../types/webMetrics';
import { TimelineChart } from './TimelineChart';

const buckets: MetricsBucket[] = [12000, 36000, 0, 18000, 54000, 27000, 9000].map((totalTokens, index) => ({
  label: `2026-09-${String(index + 1).padStart(2, '0')}`,
  totalTokens,
  inputTokens: totalTokens * 0.75,
  outputTokens: totalTokens * 0.25,
}));

const meta = {
  title: 'Metrics/TimelineChart',
  component: TimelineChart,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-2xl flex-col gap-6 bg-doom-bg p-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-doom-hi">Daily usage, including an inactive day</h2>
        <TimelineChart buckets={buckets} bucketUnit="day" />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-doom-hi">One bucket</h2>
        <TimelineChart buckets={buckets.slice(0, 1)} bucketUnit="day" />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm text-doom-hi">No usage</h2>
        <TimelineChart
          buckets={buckets.map((bucket) => ({ ...bucket, totalTokens: 0, inputTokens: 0, outputTokens: 0 }))}
        />
      </section>
    </div>
  ),
};

export const Empty = {
  render: () => (
    <div className="max-w-2xl bg-doom-bg p-6">
      <TimelineChart buckets={[]} />
    </div>
  ),
};
