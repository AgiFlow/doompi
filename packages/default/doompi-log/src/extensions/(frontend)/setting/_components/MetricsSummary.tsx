import type { MetricsTotals } from '../../../../types/webMetrics';
import { formatTokens } from '../_lib/chartScale';

/** Independent counters, never a stacked breakdown of the provider total. */
export function MetricsSummary({ totals }: { totals: MetricsTotals }) {
  const cards = [
    { label: 'Total tokens', value: totals.totalTokens, detail: 'Provider-reported total', color: 'text-doom-blue' },
    { label: 'Input tokens', value: totals.inputTokens, detail: 'Reported input counter', color: 'text-doom-hi' },
    { label: 'Output tokens', value: totals.outputTokens, detail: 'Reported output counter', color: 'text-doom-hi' },
    {
      label: 'Recorded issues',
      value: totals.issueCount,
      detail: 'Detected in this selection',
      color: totals.issueCount > 0 ? 'text-doom-yellow' : 'text-doom-hi',
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 @3xl:grid-cols-4" data-testid="metrics-summary">
      {cards.map((card) => (
        <div key={card.label} className="min-w-0 rounded-lg border border-doom-border bg-doom-panel p-4">
          <dt className="text-sm text-doom-dim">{card.label}</dt>
          <dd
            className={`mt-2 text-lg font-bold tabular-nums ${card.color}`}
            title={Number.isFinite(card.value) ? card.value.toLocaleString('en-US') : 'Not reported'}
          >
            {formatTokens(card.value)}
          </dd>
          <dd className="mt-1 text-xs text-doom-dim">{card.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
