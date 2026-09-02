import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import type { LogMetricGroupRow, LogMetricsReport, ToolMetricRow } from '@agimon-ai/log-sink-mcp';
import { Hono } from 'hono';
import { createIssuesSource } from './node/issuesSource.ts';
import { createMetricsSource } from './node/metricsSource.ts';
import type { IssuesSource } from '../types/issuesSource.ts';
import type { MetricsFilter, MetricsSource } from '../types/metricsSource.ts';
import {
  isMetricsDimension,
  isMetricsPeriod,
  LOG_API_BASE_PATH,
  ISSUE_SAMPLE_LIMIT,
  METRICS_GROUP_LIMIT,
  METRICS_QUERY_PARAMS,
  METRICS_TOOL_LIMIT,
  type MetricsBucket,
  type MetricsDimension,
  type MetricsGroup,
  type MetricsPeriod,
  type MetricsReport,
  type MetricsTool,
  type MetricsUnavailable,
  type IssuesView,
} from '../types/webMetrics.ts';

/**
 * The cockpit's half of this package's metrics access.
 *
 * Hub-scoped rather than session-scoped: the questions this answers, where the
 * tokens went and which agents failed, are about the machine over time, and a
 * session server can only see itself. The sink is already machine-wide, so the
 * hub is the only place the two agree.
 *
 * The query path is not reimplemented here. `createMetricsSource` already owns
 * the sink's two transports and its fallback order, and the TUI overlay reads
 * through the same source, so both surfaces answer from one implementation.
 */

const DEFAULT_DIMENSION: MetricsDimension = 'model';
const DEFAULT_PERIOD: MetricsPeriod = 'week';

/** The sink groups sessions under a different name than the page's dimension. */
const SINK_GROUP_BY = {
  session: 'session',
  agent: 'agent',
  model: 'model',
  provider: 'provider',
} as const;

function toBucket(bucket: LogMetricsReport['timeline'][number]): MetricsBucket {
  return {
    label: bucket.label,
    totalTokens: bucket.totalTokens,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
  };
}

function toGroup(row: LogMetricGroupRow): MetricsGroup {
  return {
    key: row.key,
    totalTokens: row.totalTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    issueCount: row.issueCount,
    failed: row.failed,
  };
}

/**
 * The turn's p90 rather than a sum: the sink attributes a whole turn's tokens
 * to every tool that ran in it, so adding them across calls would multiply the
 * same tokens by however many tools shared the turn.
 */
function toTool(row: ToolMetricRow): MetricsTool {
  return {
    name: row.toolName,
    calls: row.invocationCount,
    p90TotalTokens: row.toolCallTurn.p90TotalTokens,
  };
}

/** Which filter field carries a focus value, per dimension. */
const FOCUS_FIELD: Record<MetricsDimension, keyof MetricsFilter> = {
  session: 'sessionId',
  agent: 'agentName',
  model: 'model',
  provider: 'provider',
};

/**
 * The focus the sink actually applied, read from its own echo.
 *
 * A daemon that predates a filter ignores it and answers with everything. If
 * the page trusted the request instead of this echo, it would label the whole
 * machine's numbers as one model's.
 */
function appliedFocus(report: LogMetricsReport, dimension: MetricsDimension): string | undefined {
  // The daemon is a separate process on its own release cadence, so its
  // response is parsed defensively rather than trusted to carry every field.
  const filters = report.filters as LogMetricsReport['filters'] | undefined;
  if (filters === undefined) return undefined;
  if (dimension === 'session') return filters.sessionId;
  if (dimension === 'agent') return filters.agentName;
  const applied = dimension === 'model' ? filters.model : filters.provider;
  if (applied === undefined) return undefined;
  return Array.isArray(applied) ? applied[0] : applied;
}

/**
 * The sink's own type says Date, but both transports parse JSON, so what
 * arrives is an ISO string. Trusting the declared type here throws on every
 * real response, which no test using a hand-built Date would ever catch.
 */
function generatedAtIso(value: LogMetricsReport['generatedAt']): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value as unknown as string);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function toReport(report: LogMetricsReport, source: MetricsSource, dimension: MetricsDimension): MetricsReport {
  const focus = appliedFocus(report, dimension);
  return {
    generatedAt: generatedAtIso(report.generatedAt),
    dimension: report.groupBy as MetricsDimension,
    period: report.period as MetricsPeriod,
    bucketUnit: String(report.bucket),
    transport: source.lastTransport(),
    ...(focus === undefined ? {} : { focus }),
    totals: {
      totalTokens: report.totals.totalTokens,
      inputTokens: report.totals.inputTokens,
      outputTokens: report.totals.outputTokens,
      cachedTokens: report.totals.cachedInputTokens,
      reasoningTokens: report.totals.reasoningOutputTokens,
      groupCount: report.totals.groupCount,
      failedGroups: report.totals.failedGroups,
      issueCount: report.totals.issueCount,
    },
    timeline: report.timeline.map(toBucket),
    groups: report.groups.map(toGroup),
    tools: report.tools.rows.map(toTool),
  };
}

/**
 * A report the sink answered but with nothing in it reads as "no data", not as
 * an empty chart. The distinction the reader needs is whether telemetry is not
 * being recorded or simply has not been recorded yet.
 */
function isEmpty(report: MetricsReport): boolean {
  return report.totals.totalTokens === 0 && report.groups.length === 0 && report.tools.length === 0;
}

export interface HubApiOptions {
  /** Injected by tests; production resolves the machine's sink. */
  source?: MetricsSource;
  issues?: IssuesSource;
}

export function createLogHubApi(options: HubApiOptions = {}): Hono {
  const app = new Hono();
  // One source for the life of the hub: it caches the resolved sink endpoint,
  // and rebuilding it per request would re-probe the daemon every time.
  const source = options.source ?? createMetricsSource();
  const issues = options.issues ?? createIssuesSource();

  app.get('/metrics', async (context) => {
    const requestedDimension = context.req.query(METRICS_QUERY_PARAMS.dimension) ?? DEFAULT_DIMENSION;
    const requestedPeriod = context.req.query(METRICS_QUERY_PARAMS.period) ?? DEFAULT_PERIOD;
    if (!isMetricsDimension(requestedDimension)) {
      return context.json({ error: `Unknown dimension '${requestedDimension}'.` }, 400);
    }
    if (!isMetricsPeriod(requestedPeriod)) {
      return context.json({ error: `Unknown period '${requestedPeriod}'.` }, 400);
    }

    const focus = context.req.query(METRICS_QUERY_PARAMS.focus);
    const filter: MetricsFilter | undefined =
      focus === undefined || focus === '' ? undefined : { [FOCUS_FIELD[requestedDimension]]: focus };

    let report: LogMetricsReport;
    try {
      report = await source.query({
        groupBy: SINK_GROUP_BY[requestedDimension],
        period: requestedPeriod,
        limit: METRICS_GROUP_LIMIT,
        toolLimit: METRICS_TOOL_LIMIT,
        ...(filter === undefined ? {} : { filter }),
      });
    } catch (error) {
      // Both transports declined. That is the ordinary state on a machine
      // where the sink has never run, so it is reported as absence rather
      // than raised as a fault the page has to render as a crash.
      const unavailable: MetricsUnavailable = {
        unavailable: 'no-sink',
        detail: error instanceof Error ? error.message : 'The log sink did not answer.',
      };
      return context.json(unavailable);
    }

    const body = toReport(report, source, requestedDimension);
    if (isEmpty(body)) {
      const unavailable: MetricsUnavailable = {
        unavailable: 'no-data',
        detail: 'The log sink is running but has recorded no usage for this period.',
      };
      return context.json(unavailable);
    }
    return context.json(body);
  });

  /**
   * The detail behind the count the report carries. Separate from /metrics
   * because it costs a subprocess: the running daemon has no issues route, so
   * folding it into every report would make the whole page as slow as its
   * slowest transport.
   */
  app.get('/issues', async (context) => {
    const focus = context.req.query(METRICS_QUERY_PARAMS.focus);
    try {
      const report = await issues.query({
        limit: ISSUE_SAMPLE_LIMIT,
        ...(focus === undefined || focus === '' ? {} : { sessionId: focus }),
      });
      return context.json(report satisfies IssuesView);
    } catch (error) {
      const unavailable: MetricsUnavailable = {
        unavailable: 'no-sink',
        detail: error instanceof Error ? error.message : 'The log sink did not answer.',
      };
      return context.json(unavailable);
    }
  });

  return app;
}

/** The named export a host imports from this package's built hub entry. */
export const api: DoomApi = {
  basePath: LOG_API_BASE_PATH,
  start(_context: DoomApiContext): DoomApiHandler {
    const app = createLogHubApi();
    return {
      fetch: (request) => app.fetch(request),
      // The source holds no handle of its own: the HTTP transport is a fetch
      // per query and the CLI transport is a subprocess bounded by its timeout.
      close: () => undefined,
    };
  },
};
