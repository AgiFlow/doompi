import { Badge } from '@agimon-ai/doompi-web-components';
import type { MetricsDimension, MetricsReport } from '../types/webMetrics.ts';
import { IssuesSection } from './IssuesSection.tsx';
import { GroupBars } from './charts/GroupBars.tsx';
import { TimelineChart } from './charts/TimelineChart.tsx';
import { formatTokens } from './charts/chartScale.ts';

/**
 * One report, drawn.
 *
 * Separated from the panel so the loaded shape is a pure function of a report:
 * the panel owns the selects, the fetch and the empty states, and this owns
 * what a report looks like. That split is what lets the degenerate shapes, a
 * single bucket or an all-zero series, be rendered and asserted directly.
 */

export const DIMENSION_LABELS: Record<MetricsDimension, string> = {
  session: 'session',
  agent: 'agent',
  model: 'model',
  provider: 'provider',
};

/**
 * The session dimension shows an opaque hash. doompi-telemetry hashes
 * identifier-shaped attributes before export, by design, so there is no
 * session here the cockpit could open even if the row were clickable.
 */
export const DIMENSION_NOTES: Partial<Record<MetricsDimension, string>> = {
  session: 'session ids are hashed before export, so these identify a session without naming one',
};

export interface MetricsReportViewProps {
  report: MetricsReport;
  onFocus: (key: string) => void;
}

export function MetricsReportView({ report, onFocus }: MetricsReportViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-doom-dim">
          <span>
            <span className="text-doom-hi">{formatTokens(report.totals.totalTokens)}</span> total
          </span>
          <span>
            <span className="text-doom-hi">{formatTokens(report.totals.cachedTokens)}</span> cache reads
          </span>
          <span>
            <span className="text-doom-hi">{formatTokens(report.totals.outputTokens)}</span> out
          </span>
          <span>
            <span className="text-doom-hi">{formatTokens(report.totals.inputTokens)}</span> in
          </span>
          {report.totals.reasoningTokens === 0 ? null : (
            <span>
              <span className="text-doom-hi">{formatTokens(report.totals.reasoningTokens)}</span> reasoning
            </span>
          )}
          {report.totals.issueCount === 0 ? null : <Badge tone="red">{report.totals.issueCount} issues</Badge>}
          {report.totals.failedGroups === 0 ? null : (
            <span className="text-doom-faint">
              {report.totals.failedGroups} of {report.totals.groupCount} {DIMENSION_LABELS[report.dimension]}s failed
            </span>
          )}
        </div>
        {/*
            The total is the providers' own figure, and on a cached workload
            the named parts are a fraction of a percent of it. Listing them
            beside it without this line reads as a breakdown that does not
            add up, which is worse than not showing them.
          */}
        <span className="text-[9px] text-doom-faint/70">
          total is what the providers reported and is dominated by cache traffic; the parts beside it are counted
          separately and do not sum to it
        </span>
      </div>

      <section className="flex flex-col gap-1">
        <span className="text-[9px] font-bold text-doom-faint">tokens over time</span>
        <TimelineChart buckets={report.timeline} bucketUnit={report.bucketUnit} />
      </section>

      <section className="flex flex-col gap-1">
        <span className="text-[9px] font-bold text-doom-faint">tokens by {DIMENSION_LABELS[report.dimension]}</span>
        {DIMENSION_NOTES[report.dimension] === undefined ? null : (
          <span className="text-[9px] text-doom-faint/70">{DIMENSION_NOTES[report.dimension]}</span>
        )}
        <GroupBars groups={report.groups} focus={report.focus} onFocus={onFocus} />
      </section>

      <section className="flex flex-col gap-1">
        <span className="text-[9px] font-bold text-doom-faint">tool calls</span>
        {/*
            The token column is a ranking hint, not a measurement. The sink
            attributes a turn's whole total to every tool that ran in that
            turn, so saying otherwise here would be a lie the chart repeats.
          */}
        <span className="text-[9px] text-doom-faint/70">
          call counts are exact; the token column ranks tools by the turns they ran in, and is not each tool&apos;s own
          consumption
        </span>
        <table className="w-full text-[10px]" data-testid="metrics-tools">
          {/* Without heads the two right columns are just numbers; "1006" and
              "325.9k" do not say which is a call count and which is tokens. */}
          <thead>
            <tr className="text-[9px] text-doom-faint/70">
              <th className="py-1 text-left font-normal">tool</th>
              <th className="w-20 py-1 text-right font-normal">calls</th>
              <th className="w-20 py-1 text-right font-normal">tokens</th>
            </tr>
          </thead>
          <tbody>
            {report.tools.map((tool) => (
              <tr key={tool.name} className="border-b border-doom-border/40">
                <td className="min-w-0 truncate py-1 text-doom-dim">{tool.name}</td>
                <td className="w-20 py-1 text-right text-doom-hi">{tool.calls}</td>
                <td className="w-20 py-1 text-right text-doom-faint">{formatTokens(tool.p90TotalTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <IssuesSection tools={report.tools} focus={report.dimension === 'session' ? report.focus : undefined} />

      <span className="text-[9px] text-doom-faint/70" data-testid="metrics-provenance">
        read over {report.transport ?? 'an unreported transport'} · generated {report.generatedAt}
      </span>
    </div>
  );
}
