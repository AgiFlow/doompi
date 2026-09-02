import type { LogMetricsGroupBy, LogMetricsPeriod, LogMetricsReport } from '@agimon-ai/log-sink-mcp';

/**
 * Narrowing one query to a single group, for a reader who clicked a row.
 *
 * Every field is optional and callers that pass none behave exactly as before,
 * which is what keeps the TUI overlay unaffected. The sink echoes the filters
 * it actually applied back on the report, so a caller can tell an honoured
 * filter from one an older daemon ignored rather than presenting unfiltered
 * numbers as filtered ones.
 */
export interface MetricsFilter {
  sessionId?: string;
  agentName?: string;
  model?: string;
  provider?: string;
}

export interface MetricsQueryParams {
  groupBy: LogMetricsGroupBy;
  period: LogMetricsPeriod;
  limit: number;
  /** How many tool rows to rank; defaults to the overlay's one. */
  toolLimit?: number;
  filter?: MetricsFilter;
}

export type MetricsQuery = (params: MetricsQueryParams) => Promise<LogMetricsReport>;

export type MetricsTransport = 'http' | 'cli';

/**
 * The log-sink instance the history transports read.
 *
 * A local instance is scoped to one repository and a global one is shared, so
 * an empty history panel means something different in each case. The overlay
 * reports this rather than leaving the reader to guess which database answered.
 */
export interface MetricsInstance {
  scope: 'local' | 'global';
  dbPath: string;
  /** The name that selected the scope: the package the sink is registered under. */
  registeredName?: string;
}

export interface MetricsSource {
  query: MetricsQuery;
  lastTransport(): MetricsTransport | undefined;
  /** Undefined when instance resolution failed; the transports still work. */
  instance?(): MetricsInstance | undefined;
}
