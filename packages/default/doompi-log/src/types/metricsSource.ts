import type { LogMetricsGroupBy, LogMetricsPeriod, LogMetricsReport } from '@agimon-ai/log-sink-mcp';

export interface MetricsQueryParams {
  groupBy: LogMetricsGroupBy;
  period: LogMetricsPeriod;
  limit: number;
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
