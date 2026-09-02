/**
 * The metrics API, shared by this package's hub-scoped route and its cockpit
 * plugin. The two halves run in different processes, so the wire vocabulary is
 * declared here: `src/web` may reach `src/types` and nothing else on the node
 * side.
 *
 * The shapes are deliberately narrower than log-sink-mcp's own report. The
 * sink's LogMetricsReport carries filters, span counts, and distribution
 * detail the page never draws, and re-exporting it would tie the browser
 * bundle to a node package's types. What crosses the wire is what a chart
 * reads.
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
} as const;

/** How many groups and tools one response carries; the page ranks, it does not page. */
export const METRICS_GROUP_LIMIT = 20;

/** One point on the cost and token timeline. */
export interface MetricsBucket {
  /** Bucket start as an ISO instant, so the browser owns the formatting. */
  startedAt: string;
  totalTokens: number;
  cost: number;
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
  cost: number;
  failed: boolean;
}

/**
 * One tool's activity.
 *
 * `calls` and `failed` are exact. `totalTokens` is not a per-tool share: the
 * sink attributes a turn's total to every tool that ran in that turn, so the
 * figure ranks tools and does not measure them. The page must say so wherever
 * it draws this field.
 */
export interface MetricsTool {
  name: string;
  calls: number;
  failed: number;
  totalTokens: number;
}

/** Which transport answered, so the page can say where its numbers came from. */
export type MetricsTransport = 'http' | 'cli';

export interface MetricsReport {
  generatedAt: string;
  dimension: MetricsDimension;
  period: MetricsPeriod;
  transport: MetricsTransport;
  totals: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    toolCalls: number;
    failedToolCalls: number;
  };
  timeline: MetricsBucket[];
  groups: MetricsGroup[];
  tools: MetricsTool[];
}

/**
 * Why the page has nothing to draw.
 *
 * The sink is a separate daemon that may be missing, older than the query, or
 * simply empty, and those are three different things to tell a reader. They
 * are not errors: metricsSource already treats a rejecting daemon as
 * unavailable rather than fatal.
 */
export type MetricsUnavailableReason = 'no-sink' | 'sink-outdated' | 'no-data';

export interface MetricsUnavailable {
  unavailable: MetricsUnavailableReason;
  detail: string;
}

export type MetricsResponse = MetricsReport | MetricsUnavailable;

export function isMetricsUnavailable(response: MetricsResponse): response is MetricsUnavailable {
  return 'unavailable' in response;
}

/** The absolute URL the page reads one report from. */
export function metricsUrl(dimension: MetricsDimension, period: MetricsPeriod): string {
  const search = new URLSearchParams({
    [METRICS_QUERY_PARAMS.dimension]: dimension,
    [METRICS_QUERY_PARAMS.period]: period,
  });
  return `/api/plugin/${LOG_API_BASE_PATH}/metrics?${search.toString()}`;
}
