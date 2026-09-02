/**
 * The metrics API, shared by this package's hub-scoped route and its cockpit
 * plugin. The two halves run in different processes, so the wire vocabulary is
 * declared here: `src/web` may reach `src/types` and nothing else on the node
 * side.
 *
 * The shapes are narrower than log-sink-mcp's own report, which carries filter
 * echoes, span counts and token distributions the page never draws.
 * Re-exporting the sink's types would also tie the browser bundle to a node
 * package. What crosses the wire is what a chart reads.
 *
 * Two things the sink does not have, so this contract does not pretend to:
 * money, and per-tool failures. The sink records tokens only, and its tool rows
 * carry an invocation count with no error field.
 */

/** The segment this package's API is mounted under, below /api/plugin. */
export const LOG_API_BASE_PATH = 'log';

/**
 * The dimensions the page offers.
 *
 * log-sink-mcp also groups by 'workflow-run', 'workflow-name', 'job' and
 * 'step'. Those are omitted on purpose: no DoomPi package emits the matching
 * attributes today, so offering them would draw an empty chart and read as a
 * bug rather than as a gap.
 */
export const METRICS_DIMENSIONS = ['session', 'agent', 'model', 'provider'] as const;
export type MetricsDimension = (typeof METRICS_DIMENSIONS)[number];

export const METRICS_PERIODS = ['day', 'week', 'month', 'all'] as const;
export type MetricsPeriod = (typeof METRICS_PERIODS)[number];

export const METRICS_QUERY_PARAMS = {
  dimension: 'dimension',
  period: 'period',
  /** Narrows the whole report to one value of the current dimension. */
  focus: 'focus',
} as const;

/** How many groups and tools one response carries; the page ranks, it does not page. */
export const METRICS_GROUP_LIMIT = 20;

/** One point on the token timeline. */
export interface MetricsBucket {
  /**
   * The sink's own local-time label ('YYYY-MM-DD', or 'YYYY-MM-DD HH:00' for an
   * hour bucket). Carried rather than derived: bucket boundaries are aligned to
   * local time, so slicing the ISO instant renders the wrong day east of
   * Greenwich.
   */
  label: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

/** One row of the selected dimension. */
export interface MetricsGroup {
  /**
   * The group's identity as the sink reports it. For the session dimension
   * this is an opaque hash, never a session the cockpit can open, because
   * doompi-telemetry hashes identifier-shaped attributes before export.
   */
  key: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Problems the sink detected for this group; 0 when it saw none. */
  issueCount: number;
  failed: boolean;
}

/**
 * One tool's activity.
 *
 * `calls` is exact. `p90TotalTokens` is not this tool's consumption: the sink
 * attributes the whole turn's tokens to every tool that ran in that turn, so
 * the figure ranks tools and does not measure them. The page must say so
 * wherever it draws this field.
 *
 * There is no failure count here because the sink's tool rows do not carry
 * one. Per-tool failures live in its separate agent-issues report, which the
 * running daemon does not expose over HTTP.
 */
export interface MetricsTool {
  name: string;
  calls: number;
  p90TotalTokens: number;
}

/** Which transport answered, so the page can say where its numbers came from. */
export type MetricsTransport = 'http' | 'cli';

export interface MetricsTotals {
  /**
   * The providers' own reported total. It is not inputTokens + outputTokens:
   * on a cached agent workload it is dominated by cache traffic, and those two
   * fields are a fraction of a percent of it. The page must never present the
   * three as a breakdown.
   */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Cache reads, usually the largest real component of totalTokens. */
  cachedTokens: number;
  reasoningTokens: number;
  groupCount: number;
  /** Groups the sink flagged as having failed, out of groupCount. */
  failedGroups: number;
  issueCount: number;
}

export interface MetricsReport {
  generatedAt: string;
  dimension: MetricsDimension;
  period: MetricsPeriod;
  /**
   * The width of one timeline bucket, chosen by the sink from the period. A
   * long period over a short history collapses to a single bucket, so the page
   * says which unit it is drawing rather than implying a series it does not
   * have.
   */
  bucketUnit: string;
  /**
   * The dimension value this report is narrowed to, echoed back from the sink
   * rather than from the request. A daemon older than the filter ignores it
   * and returns everything, so trusting the request would label unfiltered
   * numbers as filtered; absence here means the drill-down did not happen.
   */
  focus?: string;
  /** Undefined when the source could not say which transport answered. */
  transport?: MetricsTransport;
  totals: MetricsTotals;
  timeline: MetricsBucket[];
  groups: MetricsGroup[];
  tools: MetricsTool[];
}

/**
 * Why the page has nothing to draw.
 *
 * The sink is a separate daemon that may be missing or simply empty, and those
 * are different things to tell a reader. Neither is an error: the metrics
 * source already treats a rejecting daemon as unavailable rather than fatal.
 *
 * 'no-api' is the third case and belongs to the cockpit rather than the sink.
 * A hub serving a bundle without package APIs mounted answers this route with
 * the SPA shell, and a 200 of HTML must read as a feature that is not
 * installed, not as a corrupt response.
 */
export type MetricsUnavailableReason = 'no-sink' | 'no-data' | 'no-api';

export interface MetricsUnavailable {
  unavailable: MetricsUnavailableReason;
  detail: string;
}

export type MetricsResponse = MetricsReport | MetricsUnavailable;

export function isMetricsUnavailable(response: MetricsResponse): response is MetricsUnavailable {
  return 'unavailable' in response;
}

export function isMetricsDimension(value: string): value is MetricsDimension {
  return (METRICS_DIMENSIONS as readonly string[]).includes(value);
}

export function isMetricsPeriod(value: string): value is MetricsPeriod {
  return (METRICS_PERIODS as readonly string[]).includes(value);
}

/** One tool's failure count, paired with its call count from the metrics report. */
export interface IssueToolRow {
  name: string;
  failures: number;
}

/**
 * One recurring problem, as the sink fingerprints it.
 *
 * `occurrenceCount` is how many times it happened, which is the number a
 * reader acts on. `detail` is the actionable line; `message` is often only a
 * record name such as 'pi.tool_result'.
 */
export interface IssueSample {
  fingerprint: string;
  occurrenceCount: number;
  category: string;
  timestamp: string;
  level: string;
  message: string;
  detail: string;
  tool: string | null;
  errorType: string | null;
  agentName: string | null;
  model: string | null;
  statusCode: string | null;
}

/**
 * The detail behind the issue count.
 *
 * Fetched separately from the report because the running sink exposes no
 * issues route over HTTP, so this costs a subprocess. The page asks for it
 * when a reader opens the section, not with every refresh.
 */
export interface IssuesView {
  totalIssues: number;
  uniqueIncidents: number;
  byCategory: Record<string, number>;
  byTool: Record<string, number>;
  byErrorType: Record<string, number>;
  samples: IssueSample[];
}

export type IssuesResponse = IssuesView | MetricsUnavailable;

export function isIssuesUnavailable(response: IssuesResponse): response is MetricsUnavailable {
  return 'unavailable' in response;
}

/** How many incidents the issues section ranks. */
export const ISSUE_SAMPLE_LIMIT = 50;

/** How many tool rows the report ranks, so a failing tool has a denominator. */
export const METRICS_TOOL_LIMIT = 15;

/** The absolute URL the page reads the issue detail from. */
export function issuesUrl(focus?: string): string {
  const search = new URLSearchParams();
  if (focus !== undefined && focus !== '') search.set(METRICS_QUERY_PARAMS.focus, focus);
  const query = search.toString();
  return `/api/plugin/${LOG_API_BASE_PATH}/issues${query === '' ? '' : `?${query}`}`;
}

/** The absolute URL the page reads one report from; `focus` narrows it to one group. */
export function metricsUrl(dimension: MetricsDimension, period: MetricsPeriod, focus?: string): string {
  const search = new URLSearchParams({
    [METRICS_QUERY_PARAMS.dimension]: dimension,
    [METRICS_QUERY_PARAMS.period]: period,
  });
  if (focus !== undefined && focus !== '') search.set(METRICS_QUERY_PARAMS.focus, focus);
  return `/api/plugin/${LOG_API_BASE_PATH}/metrics?${search.toString()}`;
}
