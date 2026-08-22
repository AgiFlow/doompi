/**
 * Session-local aggregation of the log records the Pi telemetry extension
 * already emits.
 *
 * The aggregator is fed `(recordName, attributes)` pairs rather than Pi events
 * so it can only ever see what the sink sees: no extra instrumentation is added
 * for metrics, and nothing here depends on a live sink. Everything is scoped to
 * the current process, so there is no persistence and no query API.
 */

/** Record names the aggregator derives numbers from. */
export const TOOL_RESULT_RECORD = 'pi.tool_result';
export const API_ERROR_RECORD = 'pi.api_error';
export const TURN_FINISHED_RECORD = 'pi.turn.finished';
export const TURN_FAILED_RECORD = 'pi.turn.failed';
export const TOOL_TOKEN_SAMPLE_RECORD = 'pi.tool_token_sample';

const UNKNOWN_TOOL = 'unknown';
const TOOL_ERROR_CODE = 'tool';
const RECORD_PREFIX = 'pi.';
const DEFAULT_MAX_RECENT_ERRORS = 8;
const P95_QUANTILE = 0.95;
const P90_QUANTILE = 0.9;
const ABORTED_OUTCOME = 'aborted';

/**
 * Failure taxonomy, mirroring log-sink's AgentIssueCategory closely enough that
 * a session-local category reads the same as the one the sink would report for
 * the same record. Rate limiting and provider outages are split out because
 * they call for different action: back off versus retry elsewhere.
 */
const RATE_LIMIT_STATUS = 429;
const SERVER_ERROR_STATUS = 500;
const CATEGORY_TOOL_FAILURE = 'tool_failure';
const CATEGORY_RATE_LIMITED = 'rate_limited';
const CATEGORY_PROVIDER_UNAVAILABLE = 'provider_unavailable';
const CATEGORY_API_ERROR = 'api_error';
const CATEGORY_ABORTED = 'aborted';
const CATEGORY_TURN_FAILED = 'turn_failed';
const CATEGORY_LOG_ERROR = 'log_error';

/**
 * Latency is kept as a fixed logarithmic histogram rather than a sample array,
 * so a long session cannot grow the retained state without bound. Each bucket
 * is 10% wider than the last, which keeps the reported p95 within about 10% of
 * the true value while capping the state at one small map per tool.
 */
const LATENCY_BUCKET_GROWTH = 1.1;
const LATENCY_BUCKET_LOG_BASE = Math.log(LATENCY_BUCKET_GROWTH);
const MINIMUM_SAMPLE_MS = 1;

/** Bucket ceiling per tool: covers 1ms to roughly an hour at 10% resolution. */
export const MAX_RETAINED_STATE_PER_TOOL = 160;

/**
 * Token distributions reuse the same histogram at a higher ceiling: a turn's
 * total can run to millions once cache reads are counted, which the latency
 * ceiling would saturate and report as a flat maximum.
 */
export const MAX_RETAINED_TOKEN_BUCKETS = 200;

export interface LogMetricsTokenTotals {
  input: number;
  output: number;
  total: number;
  /**
   * Cached prompt tokens billed at the read rate. Held separately from `input`
   * because the ratio between them is the session's cache hit rate, which is
   * the single largest cost lever a user controls.
   */
  cacheRead: number;
  cacheWrite: number;
}

export interface LogMetricsToolLatency {
  name: string;
  calls: number;
  p95Ms?: number;
  /** Buckets currently held for this tool, bounded by MAX_RETAINED_STATE_PER_TOOL. */
  retainedStateSize: number;
}

export interface LogMetricsEventCount {
  name: string;
  count: number;
}

export interface LogMetricsOperationDuration {
  name: string;
  calls: number;
  p95Ms?: number;
  retainedStateSize: number;
}

export interface LogMetricsError {
  at: number;
  event: string;
  message: string;
  code: string;
}

/**
 * What a tool costs, rather than how long it takes.
 *
 * `p90Tokens` is the 90th percentile of the *turn* total for turns this tool
 * took part in, which is the only attribution the Pi extension emits
 * (`token_attribution: 'toolCallTurn'`). It answers "when this tool runs, how
 * expensive is the turn", not "this tool consumed N tokens" — a turn with
 * several tool calls attributes its total to each of them.
 */
export interface LogMetricsToolCost {
  name: string;
  calls: number;
  failed: number;
  /** Turns carrying usage that this tool took part in, i.e. the p90 sample count. */
  samples: number;
  p90Tokens?: number;
}

export interface LogMetricsSnapshot {
  events: number;
  errors: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Turns that reported usage, i.e. the denominator for per-turn averages. */
  turns: number;
  abortedTurns: number;
  failedTurns: number;
  tokens: LogMetricsTokenTotals;
  cost: number;
  toolLatency: LogMetricsToolLatency[];
  toolCost: LogMetricsToolCost[];
  failureCategories: LogMetricsEventCount[];
  eventVolume: LogMetricsEventCount[];
  packageEvents: LogMetricsEventCount[];
  sanitizedFailures: number;
  operationDuration: LogMetricsOperationDuration[];
  recentErrors: LogMetricsError[];
}

export interface LogMetricsAggregatorOptions {
  now?: () => number;
  maxRecentErrors?: number;
}

/** The slice of the aggregator the telemetry extension needs. */
export interface LogMetricsRecorder {
  record(name: string, attributes: Record<string, unknown>): void;
}

interface ToolLatencyState {
  calls: number;
  samples: number;
  buckets: Map<number, number>;
}

interface SampleState {
  samples: number;
  buckets: Map<number, number>;
}

function emptySampleState(): SampleState {
  return { samples: 0, buckets: new Map<number, number>() };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeMetricName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9@/._:-]/g, '_').slice(0, 128);
  return normalized || 'unknown';
}

function bucketIndex(value: number, cap: number): number {
  const index = Math.ceil(Math.log(Math.max(value, MINIMUM_SAMPLE_MS)) / LATENCY_BUCKET_LOG_BASE);
  return Math.min(Math.max(index, 0), cap - 1);
}

function bucketUpperBound(index: number): number {
  return LATENCY_BUCKET_GROWTH ** index;
}

function observe(state: SampleState, value: number, cap: number): void {
  const bucket = bucketIndex(value, cap);
  state.buckets.set(bucket, (state.buckets.get(bucket) ?? 0) + 1);
  state.samples += 1;
}

/**
 * The upper edge of the first bucket whose cumulative count crosses the
 * quantile. Reporting the edge rather than a bucket midpoint keeps the answer
 * an upper bound, so a single 250ms call never reports faster than 250ms.
 */
function bucketedQuantile(state: SampleState, quantile: number): number | undefined {
  if (state.samples === 0) return undefined;

  const target = state.samples * quantile;
  const indexes = [...state.buckets.keys()].sort((left, right) => left - right);
  let cumulative = 0;
  let selected = indexes[0] as number;
  for (const index of indexes) {
    cumulative += state.buckets.get(index) ?? 0;
    selected = index;
    if (cumulative >= target) break;
  }
  return Math.round(bucketUpperBound(selected));
}

function bucketedP95(state: SampleState): number | undefined {
  return bucketedQuantile(state, P95_QUANTILE);
}

/** Categorises an HTTP failure so the action it implies is distinguishable. */
function apiErrorCategory(status: number): string {
  if (status === RATE_LIMIT_STATUS) return CATEGORY_RATE_LIMITED;
  if (status >= SERVER_ERROR_STATUS) return CATEGORY_PROVIDER_UNAVAILABLE;
  return CATEGORY_API_ERROR;
}

/** Strips the `pi.` prefix so an error entry reads as the event it came from. */
function errorEventName(recordName: string): string {
  return recordName.startsWith(RECORD_PREFIX) ? recordName.slice(RECORD_PREFIX.length) : recordName;
}

export class LogMetricsAggregator implements LogMetricsRecorder {
  private events = 0;
  private errors = 0;
  private toolCalls = 0;
  private failedToolCalls = 0;
  private turns = 0;
  private abortedTurns = 0;
  private failedTurns = 0;
  private cost = 0;
  private readonly tokens: LogMetricsTokenTotals = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  private readonly eventCounts = new Map<string, number>();
  private readonly packageCounts = new Map<string, number>();
  private readonly tools = new Map<string, ToolLatencyState>();
  private readonly toolTokens = new Map<string, SampleState>();
  private readonly toolFailures = new Map<string, number>();
  private readonly failureCategories = new Map<string, number>();
  private readonly operations = new Map<string, ToolLatencyState>();
  private sanitizedFailures = 0;
  private readonly errorLog: LogMetricsError[] = [];
  private readonly now: () => number;
  private readonly maxRecentErrors: number;

  constructor(options: LogMetricsAggregatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecentErrors = options.maxRecentErrors ?? DEFAULT_MAX_RECENT_ERRORS;
  }

  record(name: string, attributes: Record<string, unknown>): void {
    const metricName = safeMetricName(name);
    this.events += 1;
    this.eventCounts.set(metricName, (this.eventCounts.get(metricName) ?? 0) + 1);
    const packageName = readString(attributes['telemetry.package']);
    if (packageName && !packageName.startsWith('/') && !packageName.includes('\\')) {
      const safePackageName = safeMetricName(packageName);
      this.packageCounts.set(safePackageName, (this.packageCounts.get(safePackageName) ?? 0) + 1);
    }
    this.recordOperationDuration(metricName, attributes);
    this.recordSanitizedFailure(metricName, attributes);

    if (metricName === TOOL_RESULT_RECORD) this.recordToolResult(metricName, attributes);
    else if (metricName === API_ERROR_RECORD) this.recordApiError(metricName, attributes);
    else if (metricName === TURN_FINISHED_RECORD) this.recordTurnUsage(attributes);
    else if (metricName === TURN_FAILED_RECORD) this.recordTurnFailure(attributes);
    else if (metricName === TOOL_TOKEN_SAMPLE_RECORD) this.recordToolTokenSample(attributes);
  }

  snapshot(): LogMetricsSnapshot {
    const toolLatency = [...this.tools.entries()]
      .map(([name, state]) => {
        const p95Ms = bucketedP95(state);
        return {
          name,
          calls: state.calls,
          retainedStateSize: state.buckets.size,
          ...(p95Ms === undefined ? {} : { p95Ms }),
        };
      })
      .sort((left, right) => (right.p95Ms ?? -1) - (left.p95Ms ?? -1));

    const eventVolume = [...this.eventCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count);
    const packageEvents = [...this.packageCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count);
    const operationDuration = [...this.operations.entries()]
      .map(([name, state]) => {
        const p95Ms = bucketedP95(state);
        return {
          name,
          calls: state.calls,
          retainedStateSize: state.buckets.size,
          ...(p95Ms === undefined ? {} : { p95Ms }),
        };
      })
      .sort((left, right) => (right.p95Ms ?? -1) - (left.p95Ms ?? -1));

    return {
      events: this.events,
      errors: this.errors,
      toolCalls: this.toolCalls,
      failedToolCalls: this.failedToolCalls,
      turns: this.turns,
      abortedTurns: this.abortedTurns,
      failedTurns: this.failedTurns,
      tokens: { ...this.tokens },
      cost: this.cost,
      toolLatency,
      toolCost: this.toolCostRows(),
      failureCategories: [...this.failureCategories.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count),
      eventVolume,
      packageEvents,
      sanitizedFailures: this.sanitizedFailures,
      operationDuration,
      recentErrors: this.errorLog.map((entry) => ({ ...entry })),
    };
  }

  /**
   * Ranked by cost per call rather than call count: a tool invoked twice into a
   * 300k-token turn is the one worth changing, and a frequency ranking buries
   * it under the cheap tools that dominate any transcript.
   */
  private toolCostRows(): LogMetricsToolCost[] {
    const names = new Set([...this.tools.keys(), ...this.toolTokens.keys()]);
    return [...names]
      .map((name) => {
        const tokens = this.toolTokens.get(name);
        const p90Tokens = tokens ? bucketedQuantile(tokens, P90_QUANTILE) : undefined;
        return {
          name,
          calls: this.tools.get(name)?.calls ?? 0,
          failed: this.toolFailures.get(name) ?? 0,
          samples: tokens?.samples ?? 0,
          ...(p90Tokens === undefined ? {} : { p90Tokens }),
        };
      })
      .sort((left, right) => (right.p90Tokens ?? -1) - (left.p90Tokens ?? -1));
  }

  private countCategory(category: string): void {
    this.failureCategories.set(category, (this.failureCategories.get(category) ?? 0) + 1);
  }

  private recordOperationDuration(recordName: string, attributes: Record<string, unknown>): void {
    const duration = Object.entries(attributes).find(
      ([key, value]) =>
        key !== 'tool.duration_ms' &&
        (key === 'duration_ms' || key.endsWith('.duration_ms')) &&
        readNumber(value) !== undefined,
    );
    if (!duration) return;
    const operationName = safeMetricName(readString(attributes['operation.name']) ?? recordName);
    const state = this.operations.get(operationName) ?? { calls: 0, samples: 0, buckets: new Map<number, number>() };
    this.operations.set(operationName, state);
    state.calls += 1;
    const durationMs = readNumber(duration[1]);
    if (durationMs === undefined) return;
    observe(state, durationMs, MAX_RETAINED_STATE_PER_TOOL);
  }

  private recordSanitizedFailure(recordName: string, attributes: Record<string, unknown>): void {
    const outcome = readString(attributes.outcome);
    const failed =
      attributes['tool.result.error'] === true ||
      recordName === API_ERROR_RECORD ||
      outcome === 'error' ||
      outcome === 'failed' ||
      outcome === 'failure';
    if (!failed) return;
    this.sanitizedFailures += 1;
    if (recordName === TOOL_RESULT_RECORD || recordName === API_ERROR_RECORD) return;
    // Turn failures carry their own category, applied by recordTurnFailure.
    if (recordName !== TURN_FAILED_RECORD) this.countCategory(CATEGORY_LOG_ERROR);
    const code = readString(attributes['error.code']) ?? outcome ?? 'error';
    this.pushError(recordName, `${readString(attributes['error.type']) ?? 'operation'} failed`, safeMetricName(code));
  }

  private recordToolResult(recordName: string, attributes: Record<string, unknown>): void {
    const toolName = readString(attributes['tool.name']) ?? UNKNOWN_TOOL;
    const state = this.tools.get(toolName) ?? { calls: 0, samples: 0, buckets: new Map<number, number>() };
    this.tools.set(toolName, state);
    state.calls += 1;
    this.toolCalls += 1;

    // A call whose start was never seen carries no duration, so it counts as a
    // call but contributes no latency sample.
    const durationMs = readNumber(attributes['tool.duration_ms']);
    if (durationMs !== undefined) observe(state, durationMs, MAX_RETAINED_STATE_PER_TOOL);

    if (attributes['tool.result.error'] === true) {
      this.failedToolCalls += 1;
      this.toolFailures.set(toolName, (this.toolFailures.get(toolName) ?? 0) + 1);
      this.countCategory(CATEGORY_TOOL_FAILURE);
      // Redaction is on by default, so the tool's own output is unavailable and
      // the tool name is the only detail this entry can carry.
      this.pushError(recordName, `${toolName}: tool call failed`, TOOL_ERROR_CODE);
    }
  }

  /**
   * Attributes a turn's token total to every tool that ran in it. The Pi
   * extension emits one sample per tool result carrying the whole turn's usage,
   * so this builds a per-tool distribution of "how expensive is a turn that
   * uses this tool" — see LogMetricsToolCost for what that does and does not
   * claim.
   */
  private recordToolTokenSample(attributes: Record<string, unknown>): void {
    const totalTokens = readNumber(attributes['gen_ai.usage.total_tokens']);
    if (totalTokens === undefined || totalTokens <= 0) return;
    const toolName = readString(attributes['tool.name']) ?? UNKNOWN_TOOL;
    const state = this.toolTokens.get(toolName) ?? emptySampleState();
    this.toolTokens.set(toolName, state);
    observe(state, totalTokens, MAX_RETAINED_TOKEN_BUCKETS);
  }

  private recordApiError(recordName: string, attributes: Record<string, unknown>): void {
    this.errors += 1;
    const statusCode = readNumber(attributes['http.response.status_code']);
    const status = String(attributes['http.response.status_code']);
    this.countCategory(statusCode === undefined ? CATEGORY_API_ERROR : apiErrorCategory(statusCode));
    this.pushError(recordName, `provider responded ${status}`, status);
  }

  private recordTurnUsage(attributes: Record<string, unknown>): void {
    this.turns += 1;
    this.tokens.input += readNumber(attributes['gen_ai.usage.input_tokens']) ?? 0;
    this.tokens.output += readNumber(attributes['gen_ai.usage.output_tokens']) ?? 0;
    this.tokens.total += readNumber(attributes['gen_ai.usage.total_tokens']) ?? 0;
    this.tokens.cacheRead += readNumber(attributes['gen_ai.usage.cache_read_tokens']) ?? 0;
    this.tokens.cacheWrite += readNumber(attributes['gen_ai.usage.cache_write_tokens']) ?? 0;
    this.cost += readNumber(attributes['gen_ai.usage.cost']) ?? 0;
  }

  /** A turn the user has to redo: the most expensive failure mode there is. */
  private recordTurnFailure(attributes: Record<string, unknown>): void {
    const aborted = readString(attributes.outcome) === ABORTED_OUTCOME;
    if (aborted) this.abortedTurns += 1;
    else this.failedTurns += 1;
    this.countCategory(aborted ? CATEGORY_ABORTED : CATEGORY_TURN_FAILED);
  }

  private pushError(recordName: string, message: string, code: string): void {
    this.errorLog.unshift({ at: this.now(), event: errorEventName(recordName), message, code });
    if (this.errorLog.length > this.maxRecentErrors) this.errorLog.length = this.maxRecentErrors;
  }
}
