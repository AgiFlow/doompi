import type { MetricsDimension, MetricsPeriod, MetricsReport } from '../../../../types/webMetrics';
import { formatTokens } from '../_lib/chartScale';
import { GroupBars } from './charts/GroupBars';
import { TimelineChart } from './charts/TimelineChart';
import { IssuesSection } from './IssuesSection';
import { MetricsSummary } from './MetricsSummary';
import { ToolMetrics } from './ToolMetrics';

export const DIMENSION_LABELS: Record<MetricsDimension, string> = {
  session: 'session',
  agent: 'agent',
  model: 'model',
  provider: 'provider',
};
export const DIMENSION_NOTES: Partial<Record<MetricsDimension, string>> = {
  session: 'Session ids are hashed before export. Select a row to filter usage, not to open a session.',
};

export interface MetricsReportViewProps {
  report: MetricsReport;
  onFocus: (key: string) => void;
  onPeriodChange?: (period: MetricsPeriod) => void;
}

/** The same data-only dashboard is rendered by the stories and the settings panel. */
export function MetricsReportView({ report, onFocus, onPeriodChange }: MetricsReportViewProps) {
  const label = DIMENSION_LABELS[report.dimension];
  const unattributed = report.groups
    .filter((group) => group.key === 'unknown' || group.key === '')
    .reduce((sum, group) => sum + group.totalTokens, 0);
  const counters = [
    { name: 'Cache reads', value: report.totals.cachedTokens },
    { name: 'Reasoning tokens', value: report.totals.reasoningTokens },
    { name: 'Usage events', value: report.totals.usageEventCount },
    { name: 'Log and span records', value: report.totals.totalRecords },
  ];
  const generated = new Date(report.generatedAt);
  return (
    <div className="@container flex w-full min-w-0 flex-col gap-4" data-testid="metrics-report">
      <MetricsSummary totals={report.totals} />
      <div className="grid min-w-0 grid-cols-1 gap-4 @3xl:grid-cols-3">
        <section
          className="flex min-w-0 flex-col gap-4 rounded-lg border border-doom-border bg-doom-panel p-4 @3xl:col-span-2"
          aria-label="Usage over time"
        >
          <div>
            <h3 className="text-base font-semibold text-doom-hi">Usage over time</h3>
            <p className="mt-1 text-sm text-doom-dim">Recorded tokens, not estimated spend.</p>
          </div>
          <TimelineChart
            buckets={report.timeline}
            bucketUnit={report.bucketUnit}
            onShorterPeriod={
              report.period === 'day' || onPeriodChange === undefined ? undefined : () => onPeriodChange('day')
            }
          />
        </section>
        <section
          className="flex min-w-0 flex-col gap-4 rounded-lg border border-doom-border bg-doom-panel p-4"
          aria-label="Reported counters"
        >
          <h3 className="text-base font-semibold text-doom-hi">Reported counters</h3>
          <dl className="flex flex-col gap-3">
            {counters.map((counter) => (
              <div
                key={counter.name}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-doom-border/40 pb-3"
              >
                <dt className="text-sm text-doom-dim">{counter.name}</dt>
                <dd
                  className="text-base font-semibold tabular-nums text-doom-hi"
                  title={counter.value === undefined ? 'Not reported' : String(counter.value)}
                >
                  {formatTokens(counter.value ?? Number.NaN)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs leading-relaxed text-doom-dim">Monetary cost is not included in this metrics report.</p>
          <details className="text-xs leading-relaxed text-doom-dim">
            <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue">
              Why the counters may not add up
            </summary>
            <p className="mt-2">
              The total is reported by providers. Input, output, cache reads and reasoning are independent counters and
              may overlap or be incomplete. They are not a breakdown and may not sum to the total. A gap is not evidence
              of cache traffic. Missing fields say Not reported; a recorded zero stays zero.
            </p>
          </details>
        </section>
      </div>
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 @3xl:grid-cols-2">
        <section
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-doom-border bg-doom-panel p-4"
          aria-label={`Tokens by ${label}`}
        >
          <div>
            <h3 className="text-base font-semibold text-doom-hi">Tokens by {label}</h3>
            <p className="mt-1 text-sm text-doom-dim">Largest recorded consumers. Select a named row to filter.</p>
          </div>
          {unattributed > 0 ? (
            <div
              className="rounded-md border border-doom-edge-yellow bg-doom-tint-yellow p-3"
              data-testid="metrics-attribution-notice"
            >
              <p className="text-sm font-semibold text-doom-yellow">
                {label.charAt(0).toUpperCase() + label.slice(1)} attribution missing
              </p>
              <p className="mt-1 text-sm leading-relaxed text-doom-dim">
                {formatTokens(unattributed)} tokens have no {label} recorded. They are included in the total, but cannot
                be assigned to a named {label}.
              </p>
            </div>
          ) : null}
          {DIMENSION_NOTES[report.dimension] === undefined ? null : (
            <p className="text-xs leading-relaxed text-doom-dim">{DIMENSION_NOTES[report.dimension]}</p>
          )}
          <GroupBars
            key={`${report.dimension}:${report.focus ?? ''}`}
            groups={report.groups}
            totalTokens={report.totals.totalTokens}
            focus={report.focus}
            onFocus={onFocus}
          />
          <p className="text-xs text-doom-dim">
            Showing {report.groups.length} of {formatTokens(report.totals.groupCount)} {label} groups. Bars show share
            of the reported total.
          </p>
          {report.totals.failedGroups > 0 ? (
            <p className="text-sm text-doom-yellow">
              {report.totals.failedGroups} of {report.totals.groupCount} {label}s failed
            </p>
          ) : null}
        </section>
        <ToolMetrics tools={report.tools} />
      </div>
      <IssuesSection
        key={`${report.generatedAt}:${report.dimension}:${report.focus ?? ''}`}
        tools={report.tools}
        focus={report.dimension === 'session' ? report.focus : undefined}
        count={report.totals.issueCount}
        startTime={report.startTime}
        endTime={report.endTime}
        broaderScope={report.focus !== undefined && report.dimension !== 'session'}
      />
      <footer
        className="flex flex-wrap justify-between gap-2 border-t border-doom-border pt-3 text-xs text-doom-dim"
        data-testid="metrics-provenance"
      >
        <span>
          Source: LogSink ·{' '}
          {report.transport === 'http'
            ? 'HTTP'
            : report.transport === 'worker'
              ? 'database worker'
              : 'transport not reported'}
        </span>
        <span title={report.generatedAt}>
          Report generated {Number.isNaN(generated.getTime()) ? report.generatedAt : generated.toLocaleString()}
        </span>
      </footer>
    </div>
  );
}
