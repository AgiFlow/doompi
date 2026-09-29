import { Button, EmptyState } from '@agimon-ai/doompi-web-components';

import type { MetricsDimension, MetricsUnavailable, MetricsUnavailableReason } from '../../../../types/webMetrics';
import { DIMENSION_LABELS } from './MetricsReportView';

/**
 * Everything the page says instead of, or above, a report.
 *
 * Kept pure and apart from the panel because these are the states that decide
 * whether a reader trusts the numbers, and they are the ones a fetching
 * component makes awkward to assert. The panel decides which state it is in;
 * this decides how each one reads.
 */

const EMPTY_TITLES: Record<MetricsUnavailableReason, string> = {
  'no-sink': 'no log sink',
  'no-data': 'nothing recorded yet',
  'no-api': 'metrics not installed',
  'query-error': 'metrics could not be loaded',
};

export function EmptyForReason({ response }: { response: MetricsUnavailable }) {
  return (
    <EmptyState title={EMPTY_TITLES[response.unavailable]} description={response.detail} data-testid="metrics-empty" />
  );
}

export interface FocusNoticeProps {
  /** What the reader asked to narrow to; empty means they asked for nothing. */
  requested: string;
  /** What the sink echoed back as applied; absent means it ignored the filter. */
  applied: string | undefined;
  dimension: MetricsDimension;
  onClear: () => void;
}

export function FocusNotice({ requested, applied, dimension, onClear }: FocusNoticeProps) {
  if (requested === '') return null;
  if (applied === undefined) {
    // The sink answered without echoing the filter, so these are the machine's
    // whole numbers. Saying "showing model X" over them would be a lie, so the
    // drill-down is reported as refused instead.
    return (
      <span
        className="rounded-md border border-doom-edge-yellow bg-doom-tint-yellow p-3 text-sm text-doom-yellow"
        data-testid="metrics-focus-refused"
      >
        this log sink does not support narrowing by {DIMENSION_LABELS[dimension]}, so the numbers below are still
        everything
        <Button variant="ghost" size="md" className="ml-2" onClick={onClear}>
          clear
        </Button>
      </span>
    );
  }
  return (
    <span
      className="flex flex-wrap items-center gap-2 rounded-md border border-doom-border bg-doom-panel p-3 text-sm text-doom-dim"
      data-testid="metrics-focus"
    >
      narrowed to <span className="min-w-0 break-all text-doom-hi">{applied}</span>
      <Button variant="ghost" size="md" className="ml-2" onClick={onClear}>
        clear
      </Button>
    </span>
  );
}

/** First load and filter changes have no report to display yet. */
export function MetricsLoading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite" data-testid="metrics-loading">
      <span className="text-sm text-doom-dim">Loading recorded metrics...</span>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-lg border border-doom-border bg-doom-panel motion-reduce:animate-none"
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="h-48 animate-pulse rounded-lg border border-doom-border bg-doom-panel motion-reduce:animate-none"
      />
    </div>
  );
}
