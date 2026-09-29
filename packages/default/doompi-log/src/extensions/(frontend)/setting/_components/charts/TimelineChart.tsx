import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { MetricsBucket } from '../../../../../types/webMetrics';
import { barFraction, formatTokens, seriesMax } from '../../_lib/chartScale';

const SERIES = [
  { key: 'totalTokens', label: 'Total' },
  { key: 'inputTokens', label: 'Input' },
  { key: 'outputTokens', label: 'Output' },
] as const;
const PLOT_WIDTH = 600;
const PLOT_HEIGHT = 160;
const MAX_COLUMN_WIDTH = 48;

interface TimelineChartProps {
  buckets: readonly MetricsBucket[];
  bucketUnit?: string;
  onShorterPeriod?: () => void;
}

/** Plot the sink's buckets without filling missing history or stacking counters. */
export function TimelineChart({ buckets, bucketUnit, onShorterPeriod }: TimelineChartProps) {
  const [series, setSeries] = useState<(typeof SERIES)[number]['key']>('totalTokens');
  const [activeLabel, setActiveLabel] = useState('');
  const active = buckets.find((bucket) => bucket.label === activeLabel) ?? buckets.at(-1);
  const max = seriesMax(buckets.map((bucket) => bucket[series]));
  const unit = bucketUnit ? `${bucketUnit} ` : '';
  const slot = PLOT_WIDTH / Math.max(1, buckets.length);
  const width = Math.min(MAX_COLUMN_WIDTH, slot * 0.65);

  if (buckets.length === 0) {
    return (
      <p
        className="rounded-md border border-dashed border-doom-border p-5 text-sm text-doom-dim"
        data-testid="metrics-timeline-chart"
      >
        No timeline buckets were recorded for this selection.
      </p>
    );
  }

  if (buckets.length === 1 && active !== undefined) {
    return (
      <div className="flex flex-col gap-4" data-testid="metrics-timeline-chart">
        <div className="rounded-md border border-doom-border bg-doom-deep p-5">
          <p className="text-sm text-doom-dim">{active.label}</p>
          <p className="mt-2 text-lg font-bold tabular-nums text-doom-blue" title={String(active.totalTokens)}>
            {formatTokens(active.totalTokens)} tokens
          </p>
          <p className="mt-3 text-sm leading-relaxed text-doom-dim">
            Only one {unit}bucket was recorded. There is not enough history to show a trend.
          </p>
          <p className="mt-2 text-xs text-doom-dim">For more detail, pick a shorter period when one is available.</p>
          {onShorterPeriod === undefined ? null : (
            <Button variant="ghost" size="sm" className="mt-3" onClick={onShorterPeriod}>
              View hourly detail
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="metrics-timeline-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Timeline token counter">
          {SERIES.map((item) => (
            <Button
              key={item.key}
              size="sm"
              variant={series === item.key ? 'primary' : 'ghost'}
              aria-pressed={series === item.key}
              onClick={() => setSeries(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-doom-dim">
          {buckets.length} recorded {unit}buckets
        </span>
      </div>
      <div className="flex gap-3">
        <div
          aria-hidden="true"
          className="flex w-12 shrink-0 flex-col justify-between text-right text-xs tabular-nums text-doom-dim"
        >
          <span>{formatTokens(max)}</span>
          <span>{formatTokens(max / 2)}</span>
          <span>0</span>
        </div>
        <svg
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-40 min-w-0 flex-1 overflow-visible"
          role="group"
          aria-label={`tokens per bucket, peak ${formatTokens(max)}`}
        >
          {[0, PLOT_HEIGHT / 2, PLOT_HEIGHT].map((y) => (
            <line
              key={y}
              x1="0"
              x2={PLOT_WIDTH}
              y1={y}
              y2={y}
              className="text-doom-border"
              stroke="currentColor"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {buckets.map((bucket, index) => {
            const height = barFraction(bucket[series], max) * PLOT_HEIGHT;
            const label = `${bucket.label}: ${formatTokens(bucket[series])} ${SERIES.find((item) => item.key === series)?.label.toLowerCase()} tokens`;
            return (
              <g key={bucket.label}>
                <rect
                  x={index * slot + (slot - width) / 2}
                  y={PLOT_HEIGHT - height}
                  width={width}
                  height={height}
                  rx="2"
                  fill="currentColor"
                  className={active?.label === bucket.label ? 'text-doom-cyan' : 'text-doom-blue'}
                />
                <rect
                  x={index * slot}
                  y="0"
                  width={slot}
                  height={PLOT_HEIGHT}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={label}
                  aria-pressed={active?.label === bucket.label}
                  onMouseEnter={() => setActiveLabel(bucket.label)}
                  onFocus={() => setActiveLabel(bucket.label)}
                  onClick={() => setActiveLabel(bucket.label)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setActiveLabel(bucket.label);
                    }
                  }}
                  className="cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-cyan"
                >
                  <title>{label}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="ml-15 flex justify-between gap-3 text-xs text-doom-dim">
        <span>{buckets[0]?.label}</span>
        <span className="text-right">{buckets.at(-1)?.label}</span>
      </div>
      <div
        className="flex flex-wrap justify-between gap-2 rounded-md bg-doom-deep px-3 py-2 text-sm tabular-nums"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="text-doom-dim">{active?.label}</span>
        <span className="text-doom-hi">
          {formatTokens(active?.[series] ?? Number.NaN)}{' '}
          {SERIES.find((item) => item.key === series)?.label.toLowerCase()} tokens
        </span>
      </div>
      {max === 0 ? (
        <p className="text-sm text-doom-dim">
          Recorded buckets contain zero {SERIES.find((item) => item.key === series)?.label.toLowerCase()} tokens.
        </p>
      ) : null}
      <details className="text-xs text-doom-dim">
        <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue">
          View exact bucket values
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-right tabular-nums">
            <caption className="sr-only">Independent token counters by recorded bucket</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 text-left">
                  Bucket
                </th>
                <th scope="col" className="pl-3">
                  Total
                </th>
                <th scope="col" className="pl-3">
                  Input
                </th>
                <th scope="col" className="pl-3">
                  Output
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.label} className="border-t border-doom-border">
                  <th scope="row" className="py-2 text-left font-normal">
                    {bucket.label}
                  </th>
                  {SERIES.map((item) => (
                    <td key={item.key} className="pl-3">
                      {Number.isFinite(bucket[item.key]) ? bucket[item.key].toLocaleString('en-US') : 'Not reported'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
