import { Button, EmptyState } from '@agimon-ai/doompi-web-components';
import type { MetricsDimension, MetricsUnavailable, MetricsUnavailableReason } from '../types/webMetrics.ts';
import { DIMENSION_LABELS } from './MetricsReportView.tsx';

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
      <span className="text-[10px] text-doom-yellow" data-testid="metrics-focus-refused">
        this log sink does not support narrowing by {DIMENSION_LABELS[dimension]}, so the numbers below are still
        everything
        <Button variant="ghost" size="xs" className="ml-2 text-[9px]" onClick={onClear}>
          clear
        </Button>
      </span>
    );
  }
  return (
    <span className="text-[10px] text-doom-dim" data-testid="metrics-focus">
      narrowed to <span className="text-doom-hi">{applied}</span>
      <Button variant="ghost" size="xs" className="ml-2 text-[9px]" onClick={onClear}>
        clear
      </Button>
    </span>
  );
}
