import type { MetricsBucket } from '../../types/webMetrics.ts';
import { barFraction, formatTokens, seriesMax } from './chartScale.ts';

/**
 * Tokens per bucket, as columns.
 *
 * Drawn as SVG rather than with a charting library because the cockpit bundle
 * has none and the plugin import allowlist admits none. That constraint is a
 * good fit here: this is a bar per bucket, and a dependency would cost more
 * than it saves.
 *
 * Columns use currentColor and theme classes rather than literal colours, so
 * the chart follows whichever theme the cockpit renders with.
 */

const VIEWBOX_HEIGHT = 100;

/**
 * Widest a single column may get.
 *
 * Dividing the width by the bucket count alone turns a one-bucket period into
 * a slab spanning the whole panel at full height, which reads as a rendering
 * fault rather than as "one bucket". Capping it keeps a short series looking
 * like bars on an axis.
 */
const MAX_COLUMN_PERCENT = 9;

interface TimelineChartProps {
  buckets: readonly MetricsBucket[];
  /** The sink's bucket width, named so a flat chart explains itself; absent on an older hub. */
  bucketUnit?: string;
}

export function TimelineChart({ buckets, bucketUnit }: TimelineChartProps) {
  // An older hub does not send the unit; say nothing rather than 'undefined'.
  const unit = bucketUnit === undefined || bucketUnit === '' ? '' : `${bucketUnit} `;
  const max = seriesMax(buckets.map((bucket) => bucket.totalTokens));
  const columnWidth = Math.min(MAX_COLUMN_PERCENT, 100 / Math.max(1, buckets.length));

  return (
    <div className="flex flex-col gap-1" data-testid="metrics-timeline-chart">
      <svg
        viewBox={`0 0 100 ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-24 w-full text-doom-blue"
        role="img"
        aria-label={`tokens per bucket, peak ${formatTokens(max)}`}
      >
        {buckets.map((bucket, index) => {
          const height = barFraction(bucket.totalTokens, max) * VIEWBOX_HEIGHT;
          return (
            <rect
              key={bucket.label}
              x={index * columnWidth + columnWidth * 0.15}
              y={VIEWBOX_HEIGHT - height}
              width={columnWidth * 0.7}
              height={height}
              fill="currentColor"
            >
              <title>{`${bucket.label}: ${formatTokens(bucket.totalTokens)} tokens`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex flex-wrap justify-between gap-x-3 text-[9px] text-doom-faint">
        <span>{buckets[0]?.label ?? ''}</span>
        {buckets.length > 1 ? <span>peak {formatTokens(max)}</span> : null}
        <span>
          {buckets.length === 1
            ? `one ${unit}bucket, ${formatTokens(max)}; pick a shorter period for finer buckets`
            : `${String(buckets.length)} ${unit}buckets`}
        </span>
      </div>
    </div>
  );
}
