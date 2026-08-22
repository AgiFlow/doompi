/**
 * The `SPC h l` Log Metrics overlay.
 *
 * The panel answers two questions and skips everything else: what is this
 * session costing, and what should change next. Raw plumbing counters
 * (per-record volume, sink wiring) are either derived into a finding or moved
 * behind `?`, because a number nobody can act on still costs a row.
 *
 * Rendering stays a pure `render(width)` so the layout can be asserted as text
 * without a live terminal. Every headline number comes from the in-process
 * aggregator, so the panels keep working when no sink is connected; only the
 * history panels degrade.
 */

import type { LogMetricsGroupBy, LogMetricsPeriod, LogMetricsReport } from '@agimon-ai/log-sink-mcp';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { deriveFindings, type LogMetricsFinding, type LogMetricsFindingSeverity } from '../services/findings.ts';
import type { LogMetricsSnapshot, LogMetricsToolCost } from '../services/metrics';
import type { MetricsInstance, MetricsQuery, MetricsTransport } from '../types/metricsSource.ts';
import { DOOM_OVERLAY_ACCENT, DoomOverlay, type DoomOverlayChrome, type DoomOverlayTui } from './doomOverlay.ts';

export interface SinkStatus {
  service: string;
  backend: string;
  endpoint: string;
  endpointSource: string;
  traces: boolean;
  redaction: boolean;
  fileFallback: boolean;
}

export interface LogMetricsView {
  disabled: boolean;
  snapshot: LogMetricsSnapshot;
  sink: SinkStatus | undefined;
  /** Which transport answered the last history query, for the panel status line. */
  transport?: MetricsTransport;
  /** Which sink database the history panels read, so an empty one reads as scoped rather than absent. */
  instance?: MetricsInstance;
  /**
   * Most recent telemetry diagnostic. Surfaced here because writing it to stderr
   * would corrupt the TUI frame.
   */
  lastDiagnostic?: string;
}

const TITLE = 'LOG METRICS';
const BREADCRUMB = 'SPC › h / help › l / logs';
const SUBTITLE = 'doom-log · service pi · this session';
const FOOTER = 'r refresh · g group · p period · ? detail · esc close';
const CONSUMERS_TITLE = 'TOP CONSUMERS';
const BURN_TITLE = 'TOKEN BURN';
/** Dimensions that actually carry attribution today; workflow/step stay for runner-driven work. */
const GROUP_CYCLE = ['session', 'agent', 'workflow-name', 'step'] as const satisfies readonly LogMetricsGroupBy[];
const PERIOD_CYCLE = ['day', 'week', 'month', 'all'] as const satisfies readonly LogMetricsPeriod[];
/** Head of each cycle, so the fallback never restates a literal. */
const DEFAULT_GROUP = GROUP_CYCLE[0];
const DEFAULT_PERIOD = PERIOD_CYCLE[0];
const MAX_TOKEN_ROWS = 6;
const MAX_BURN_ROWS = 8;
const GROUP_KEY_WIDTH = 20;
const AGENT_WIDTH = 12;
const BURN_LABEL_WIDTH = 17;
const LOADING_TEXT = 'loading…';
const NO_HISTORY_TEXT = 'no sink history available';
const NO_RECORDS_TEXT = 'no records';
/** Pairs with the `database` row in the detail pane. */
const SINK_SUFFIX = 'db';
const HISTORY_TITLE = 'HISTORY';
const UNKNOWN_INSTANCE = 'unresolved';
/**
 * `disabled` is also the status a handle carries before it has initialized, so
 * this row states what is true in both cases and sends the reader to `?` for
 * the cause. Naming one remedy here would assert a diagnosis the flag cannot
 * support, and the panel's rule is that a row nobody can act on costs its space.
 */
const EXPORT_OFF_TEXT = 'off · ? for details';
const DISABLED_BACKEND = 'disabled';
const FINDINGS_TITLE = 'WHAT TO FIX · derived from this session';
const NO_FINDINGS_TEXT = 'no records yet';
const TOOL_COST_TITLE = 'TOOL COST · p90 turn tokens · calls · fail% · p95';
const NO_TOOL_COST_TEXT = 'no tool calls yet';
const ERRORS_TITLE = 'RECENT ERRORS';
const NO_ERRORS_TEXT = 'none';
const SINK_TITLE = 'SINK STATUS';
const DETAIL_TITLE = 'COLLECTION';
const DISABLED_ENV = 'AGENT_TELEMETRY_DISABLED';
const NOT_CONNECTED = 'not connected';
const EMPTY_VALUE = '—';
const ELLIPSIS = '…';
const THIS_SESSION = 'this session';
const TOGGLE_ON = 'on';
const TOGGLE_OFF = 'off';
const CLEAN_TEXT = 'clean';

const MIN_TWO_COLUMN_WIDTH = 72;
const RIGHT_COLUMN_RATIO = 0.4;
const MIN_RIGHT_COLUMN = 24;
const REFRESH_MS = 1000;

const STAT_CELLS = 6;
const STAT_ROW_INDEXES = [0, 1, 2];
const TOOL_NAME_WIDTH = 10;
const VALUE_WIDTH = 8;
const CALLS_WIDTH = 6;
const FAIL_WIDTH = 6;
const LATENCY_WIDTH = 8;
const SINK_LABEL_WIDTH = 14;
const ERROR_TIME_WIDTH = 6;
/** One wider than the longest event name, so the message never abuts it. */
const ERROR_EVENT_WIDTH = 12;
const ERROR_CODE_WIDTH = 5;
const FINDING_GLYPH_WIDTH = 2;
const FINDING_SUBJECT_WIDTH = 9;
const FINDING_DETAIL_WIDTH = 25;
const MAX_TOOL_ROWS = 6;
const MAX_FINDING_ROWS = 5;
const MAX_ERROR_ROWS = 5;
/** Bar color thresholds, as a fraction of the panel's most expensive tool. */
const COST_WARN_RATIO = 0.33;
const COST_ERROR_RATIO = 0.66;
/** Below this the session is not caching effectively; above it, it is working. */
const CACHE_WARN_RATIO = 0.3;
const TOOL_FAIL_WARN_RATIO = 0.05;

const SECOND_MS = 1000;
const MILLION = 1_000_000;
const THOUSAND = 1000;
const PERCENT = 100;
const COMPACT_DECIMALS = 1;
const DURATION_DECIMALS = 2;
const COST_DECIMALS = 2;
const PER_TURN_DECIMALS = 3;
const TIME_SLICE_END = 5;

const SEVERITY_GLYPH: Record<LogMetricsFindingSeverity, string> = { critical: '▲', warning: '●', info: '·' };
const SEVERITY_COLOR: Record<LogMetricsFindingSeverity, 'error' | 'warning' | 'dim'> = {
  critical: 'error',
  warning: 'warning',
  info: 'dim',
};

function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  // An explicit ellipsis: the default '...' also emits a colour reset, which
  // leaks escape codes into the middle of a padded column.
  return visible >= width ? truncateToWidth(text, width, ELLIPSIS) : text + ' '.repeat(width - visible);
}

function padStart(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible >= width ? truncateToWidth(text, width) : ' '.repeat(width - visible) + text;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatCompact(value: number): string {
  if (value >= MILLION) return `${(value / MILLION).toFixed(COMPACT_DECIMALS)}M`;
  if (value >= THOUSAND) return `${Math.round(value / THOUSAND)}k`;
  return String(Math.round(value));
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * PERCENT)}%`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return EMPTY_VALUE;
  if (ms >= SECOND_MS) return `${(ms / SECOND_MS).toFixed(DURATION_DECIMALS)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTime(at: number): string {
  return new Date(at).toTimeString().slice(0, TIME_SLICE_END);
}

function bar(value: number, max: number, width: number): string {
  const filled = Math.min(width, Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function labelled(label: string, value: string, width: number): string {
  return truncateToWidth(pad(label, SINK_LABEL_WIDTH) + value, width);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function statCell(label: string, value: string, sublabel: string, width: number): string[] {
  return [pad(label, width), pad(value, width), pad(sublabel, width)];
}

/**
 * Colours the headline value so the two cells with a defensible threshold —
 * cache hit rate and tool failure rate — read at a glance. The others are
 * workload-dependent, and a colour on them would imply a target that does not
 * exist.
 */
function judgedCell(
  label: string,
  value: string,
  sublabel: string,
  healthy: boolean,
  width: number,
  theme: Theme,
): string[] {
  return [pad(label, width), pad(theme.fg(healthy ? 'success' : 'warning', value), width), pad(sublabel, width)];
}

/**
 * The six headline cells. Every one is a lever the user can pull: what the
 * session cost, how much of it was avoidable, and how much was thrown away.
 * Raw event and record counts were dropped — they moved with the workload and
 * nothing followed from them.
 */
function statRows(snapshot: LogMetricsSnapshot, width: number, theme: Theme): string[] {
  const cellWidth = Math.max(1, Math.floor(width / STAT_CELLS));
  const { tokens, turns } = snapshot;
  const cacheHit = ratio(tokens.cacheRead, tokens.cacheRead + tokens.input);
  const failRatio = ratio(snapshot.failedToolCalls, snapshot.toolCalls);
  const issues = snapshot.errors + snapshot.abortedTurns + snapshot.failedTurns;
  const topCategory = snapshot.failureCategories[0];
  const cells = [
    statCell(
      'TOKENS',
      formatCompact(tokens.total),
      `↑${formatCompact(tokens.input)} ↓${formatCompact(tokens.output)}`,
      cellWidth,
    ),
    judgedCell(
      'CACHE',
      formatPercent(cacheHit),
      `${formatCompact(tokens.cacheRead)} read`,
      cacheHit >= CACHE_WARN_RATIO,
      cellWidth,
      theme,
    ),
    statCell(
      'COST',
      `$${snapshot.cost.toFixed(COST_DECIMALS)}`,
      turns > 0 ? `$${(snapshot.cost / turns).toFixed(PER_TURN_DECIMALS)}/turn` : THIS_SESSION,
      cellWidth,
    ),
    statCell(
      'TURNS',
      formatCount(turns),
      turns > 0 ? `${formatCompact(tokens.total / turns)} tok/turn` : EMPTY_VALUE,
      cellWidth,
    ),
    judgedCell(
      'TOOL FAIL',
      formatPercent(failRatio),
      `${snapshot.failedToolCalls} of ${snapshot.toolCalls}`,
      failRatio <= TOOL_FAIL_WARN_RATIO,
      cellWidth,
      theme,
    ),
    judgedCell(
      'ISSUES',
      formatCount(issues),
      topCategory ? topCategory.name : CLEAN_TEXT,
      issues === 0,
      cellWidth,
      theme,
    ),
  ];
  return STAT_ROW_INDEXES.map((row) => pad(cells.map((cell) => cell[row] ?? '').join(''), width));
}

/** Cheap tools read as `success`, expensive ones as `error`. */
function costColor(value: number, max: number): 'success' | 'warning' | 'error' {
  const share = max > 0 ? value / max : 0;
  if (share >= COST_ERROR_RATIO) return 'error';
  if (share >= COST_WARN_RATIO) return 'warning';
  return 'success';
}

function findingRows(findings: readonly LogMetricsFinding[], width: number, theme: Theme): string[] {
  const actionWidth = Math.max(1, width - FINDING_GLYPH_WIDTH - FINDING_SUBJECT_WIDTH - FINDING_DETAIL_WIDTH);
  return findings
    .slice(0, MAX_FINDING_ROWS)
    .map((finding) =>
      truncateToWidth(
        theme.fg(SEVERITY_COLOR[finding.severity], pad(SEVERITY_GLYPH[finding.severity], FINDING_GLYPH_WIDTH)) +
          pad(finding.subject, FINDING_SUBJECT_WIDTH) +
          pad(finding.detail, FINDING_DETAIL_WIDTH) +
          theme.fg('dim', pad(finding.action, actionWidth)),
        width,
      ),
    );
}

/**
 * Ranked by cost per call. Latency stays as the trailing column because it is
 * occasionally the answer, but it no longer decides the ordering: a 55ms grep
 * that drags 38k tokens into the turn is the row worth reading.
 */
function toolCostRows(
  tools: readonly LogMetricsToolCost[],
  latency: Map<string, number>,
  width: number,
  theme: Theme,
): string[] {
  const entries = tools.slice(0, MAX_TOOL_ROWS);
  const barWidth = Math.max(1, width - TOOL_NAME_WIDTH - VALUE_WIDTH - CALLS_WIDTH - FAIL_WIDTH - LATENCY_WIDTH - 1);
  const max = Math.max(...entries.map((entry) => entry.p90Tokens ?? 0), 1);
  return entries.map((entry) => {
    const tokens = entry.p90Tokens ?? 0;
    const barText = theme.fg(costColor(tokens, max), bar(tokens, max, barWidth));
    const failRatio = ratio(entry.failed, entry.calls);
    const fail =
      failRatio > 0 ? theme.fg('error', padStart(formatPercent(failRatio), FAIL_WIDTH)) : padStart('0%', FAIL_WIDTH);
    return truncateToWidth(
      pad(entry.name, TOOL_NAME_WIDTH) +
        barText +
        ' ' +
        padStart(entry.p90Tokens === undefined ? EMPTY_VALUE : formatCompact(tokens), VALUE_WIDTH) +
        padStart(formatCount(entry.calls), CALLS_WIDTH) +
        fail +
        theme.fg('dim', padStart(formatDuration(latency.get(entry.name)), LATENCY_WIDTH)),
      width,
    );
  });
}

function errorRows(snapshot: LogMetricsSnapshot, width: number): string[] {
  const messageWidth = Math.max(1, width - ERROR_TIME_WIDTH - ERROR_EVENT_WIDTH - ERROR_CODE_WIDTH);
  return snapshot.recentErrors
    .slice(0, MAX_ERROR_ROWS)
    .map((entry) =>
      truncateToWidth(
        pad(formatTime(entry.at), ERROR_TIME_WIDTH) +
          pad(entry.event, ERROR_EVENT_WIDTH) +
          pad(entry.message, messageWidth) +
          padStart(entry.code, ERROR_CODE_WIDTH),
        width,
      ),
    );
}

/**
 * Three lines instead of six. Backend and endpoint answer "is anything being
 * written"; the rest of the wiring only matters when it is broken, so it moved
 * behind `?`.
 */
function sinkRows(sink: SinkStatus | undefined, width: number, lastDiagnostic?: string): string[] {
  /** Diagnostics can land before a handle exists, so both branches report them. */
  const diagnosticRows = lastDiagnostic ? [labelled('diagnostic', lastDiagnostic, width)] : [];
  if (!sink) {
    return [
      labelled('status', NOT_CONNECTED, width),
      labelled('metrics', 'aggregated in-process anyway', width),
      ...diagnosticRows,
    ];
  }
  return [
    labelled('backend', `${sink.backend} · ${sink.endpointSource}`, width),
    labelled('endpoint', sink.endpoint, width),
    // A disabled backend is the one sink state that explains an empty history,
    // so it earns a row naming the switch that turns exporting back on.
    ...(sink.backend === DISABLED_BACKEND ? [labelled('export', EXPORT_OFF_TEXT, width)] : []),
    ...diagnosticRows,
  ];
}

/** Only fields NodeTelemetryHandle can actually supply; it exposes no queue counters. */
function sinkDetailRows(sink: SinkStatus | undefined, width: number): string[] {
  if (!sink)
    return [labelled('status', NOT_CONNECTED, width), labelled('reason', 'no sink handle this session', width)];
  return [
    labelled('service', sink.service, width),
    labelled('backend', sink.backend, width),
    labelled('endpoint', `${sink.endpointSource} · ${sink.endpoint}`, width),
    labelled('traces', `${sink.traces ? TOGGLE_ON : TOGGLE_OFF} · AGENT_OTEL_TRACES`, width),
    labelled('redaction', `${sink.redaction ? TOGGLE_ON : TOGGLE_OFF} · metadata only`, width),
    labelled('file fallback', sink.fileFallback ? 'allowed' : 'disabled', width),
  ];
}

const COLLECTION_NOTE =
  'Headline counters are aggregated in-process from this session. TOP CONSUMERS and ' +
  'TOKEN BURN come from the sink database, so they span every agent and workflow in ' +
  'the selected period, not just this session.';

const INSTANCE_NOTE =
  'A local instance is scoped to this repository, so it stays empty until a sink runs for it. Start a ' +
  'sink for this workspace, or point both telemetry and this panel at the shared one with ' +
  'LOG_SINK_INSTANCE=global or by listing the name above under global.services in a .logsink.yaml.';

const ATTRIBUTION_NOTE =
  'TOOL COST reports the p90 total tokens of the turns a tool took part in, which is the ' +
  'only attribution Pi emits. A turn running several tools attributes its total to each of ' +
  'them, so the column ranks tools by the weight of the turns they appear in — it is not a ' +
  'per-tool share of spend.';

/** Ranked token consumers for the selected dimension. */
function consumerRows(report: LogMetricsReport | undefined, width: number, theme: Theme): string[] {
  const groups = report?.groups.slice(0, MAX_TOKEN_ROWS) ?? [];
  if (groups.length === 0) return [];

  const barWidth = Math.max(1, width - GROUP_KEY_WIDTH - AGENT_WIDTH - VALUE_WIDTH - 1);
  const max = Math.max(...groups.map((group) => group.totalTokens), 1);
  return groups.map((group) => {
    const barText = theme.fg(group.issueCount > 0 ? 'error' : 'accent', bar(group.totalTokens, max, barWidth));
    return truncateToWidth(
      `${pad(group.key, GROUP_KEY_WIDTH)}${pad(group.agentName ?? EMPTY_VALUE, AGENT_WIDTH)}${barText} ${padStart(
        formatCompact(group.totalTokens),
        VALUE_WIDTH,
      )}`,
      width,
    );
  });
}

/** Token burn per timeline bucket, newest last so the trend reads left to right. */
function burnRows(report: LogMetricsReport | undefined, width: number, theme: Theme): string[] {
  const buckets = report?.timeline.slice(-MAX_BURN_ROWS) ?? [];
  if (buckets.length === 0) return [];

  const barWidth = Math.max(1, width - BURN_LABEL_WIDTH - VALUE_WIDTH - 1);
  const max = Math.max(...buckets.map((bucket) => bucket.totalTokens), 1);
  return buckets.map((bucket) => {
    const barText = theme.fg('success', bar(bucket.totalTokens, max, barWidth));
    // `label` is the local-time rendering; bucketStart serialises to UTC.
    return truncateToWidth(
      `${pad(bucket.label, BURN_LABEL_WIDTH)}${barText} ${padStart(formatCompact(bucket.totalTokens), VALUE_WIDTH)}`,
      width,
    );
  });
}

/** Greedy word wrap: no library dependency for two static paragraphs. */
function wrapText(text: string, width: number): string[] {
  if (width < 1) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => pad(line, width));
}

export class LogMetricsOverlayComponent extends DoomOverlay {
  private readonly getView: () => LogMetricsView;
  private readonly done: (result: undefined) => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly query: MetricsQuery | undefined;
  private disposed = false;
  private groupIndex = 0;
  private periodIndex = 0;
  private requestId = 0;
  private loading = false;
  private showDetail = false;
  private report: LogMetricsReport | undefined;
  private reportError: string | undefined;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    getView: () => LogMetricsView,
    done: (result: undefined) => void,
    query?: MetricsQuery,
  ) {
    super(tui, theme);
    this.getView = getView;
    this.done = done;
    this.query = query;
    this.timer = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, REFRESH_MS);
    this.timer.unref?.();
    this.fetchReport();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'q')) {
      this.done(undefined);
      return;
    }

    const key = data.toLowerCase();
    if (key === '?') {
      this.showDetail = !this.showDetail;
      this.tui.requestRender();
      return;
    }
    if (key === 'g') {
      this.groupIndex = (this.groupIndex + 1) % GROUP_CYCLE.length;
      this.refresh();
      return;
    }
    if (key === 'p') {
      this.periodIndex = (this.periodIndex + 1) % PERIOD_CYCLE.length;
      this.refresh();
      return;
    }
    if (key === 'r') this.refresh();
  }

  /** Re-reads the live session counters, and restarts the history query behind them. */
  private refresh(): void {
    this.fetchReport();
    this.tui.requestRender();
  }

  /**
   * Sink history is fetched out of band: the query crosses a process boundary
   * and takes seconds on a busy database, so render never waits on it. Stale
   * responses are dropped by sequence number when the dimension changes mid
   * flight.
   */
  private fetchReport(): void {
    if (!this.query) return;

    const requestId = ++this.requestId;
    this.loading = true;
    this.reportError = undefined;
    this.query({ groupBy: this.groupBy(), period: this.period(), limit: MAX_TOKEN_ROWS })
      .then((report) => {
        if (this.disposed || requestId !== this.requestId) return;
        this.report = report;
        this.loading = false;
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        if (this.disposed || requestId !== this.requestId) return;
        this.report = undefined;
        this.reportError = error instanceof Error ? error.message : String(error);
        this.loading = false;
        this.tui.requestRender();
      });
  }

  /** Ranked consumers for the selected dimension, sourced from the sink database. */
  private consumerPanel(width: number): string[] {
    const heading = this.theme.fg('accent', `${CONSUMERS_TITLE} · by ${this.groupBy()} · ${this.period()}`);
    const rows = consumerRows(this.report, width, this.theme);
    return [heading, ...(rows.length > 0 ? rows : [this.theme.fg('dim', this.historyStatus())])];
  }

  private burnPanel(width: number): string[] {
    const bucket = this.report?.bucket ?? '';
    const heading = this.theme.fg('accent', `${BURN_TITLE}${bucket ? ` · per ${bucket}` : ''}`);
    const rows = burnRows(this.report, width, this.theme);
    return [heading, ...(rows.length > 0 ? rows : [this.theme.fg('dim', this.historyStatus())])];
  }

  private findingsPanel(snapshot: LogMetricsSnapshot, width: number): string[] {
    const rows = findingRows(deriveFindings(snapshot), width, this.theme);
    return [
      this.theme.fg('accent', FINDINGS_TITLE),
      ...(rows.length > 0 ? rows : [this.theme.fg('dim', NO_FINDINGS_TEXT)]),
    ];
  }

  private toolCostPanel(snapshot: LogMetricsSnapshot, width: number): string[] {
    const latency = new Map(
      snapshot.toolLatency.flatMap((entry) => (entry.p95Ms === undefined ? [] : [[entry.name, entry.p95Ms] as const])),
    );
    const rows = toolCostRows(snapshot.toolCost, latency, width, this.theme);
    return [
      this.theme.fg('accent', TOOL_COST_TITLE),
      ...(rows.length > 0 ? rows : [this.theme.fg('dim', NO_TOOL_COST_TEXT)]),
    ];
  }

  private errorsPanel(snapshot: LogMetricsSnapshot, width: number): string[] {
    const rows = errorRows(snapshot, width);
    return [
      this.theme.fg('accent', ERRORS_TITLE),
      ...(rows.length > 0 ? rows : [this.theme.fg('dim', NO_ERRORS_TEXT)]),
    ];
  }

  /** Which database answered, spelled out: the path is what makes an empty panel diagnosable. */
  private historyDetailRows(view: LogMetricsView, width: number): string[] {
    const instance = view.instance;
    if (!instance) return [labelled('instance', UNKNOWN_INSTANCE, width)];
    return [
      labelled('transport', view.transport ?? NOT_CONNECTED, width),
      labelled('instance', `${instance.scope}${instance.registeredName ? ` · ${instance.registeredName}` : ''}`, width),
      labelled('database', instance.dbPath, width),
    ];
  }

  private groupBy(): LogMetricsGroupBy {
    return GROUP_CYCLE[this.groupIndex] ?? DEFAULT_GROUP;
  }

  private period(): LogMetricsPeriod {
    return PERIOD_CYCLE[this.periodIndex] ?? DEFAULT_PERIOD;
  }

  /**
   * One status line for the history panels: what is shown, from where. A
   * successful query that returned nothing names the instance it read, because
   * "0 groups" reads as "this never happened" when the real answer is that a
   * repository-scoped database was asked a question only the shared one can
   * answer.
   */
  private historyStatus(): string {
    if (this.loading) return LOADING_TEXT;
    if (this.reportError) return this.reportError;
    if (!this.report) return NO_HISTORY_TEXT;
    const groupCount = this.report.totals.groupCount;
    if (groupCount > 0) return `${this.transportLabel()} · ${groupCount} groups`;
    const scope = this.getView().instance?.scope;
    return `${this.transportLabel()} · ${NO_RECORDS_TEXT}${scope ? ` · ${scope} ${SINK_SUFFIX}` : ''}`;
  }

  private transportLabel(): MetricsTransport | 'sink' {
    return this.getView().transport ?? 'sink';
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: SUBTITLE,
      footer: FOOTER,
      footerHints: [
        ['r', 'refresh'],
        ['g', 'group'],
        ['p', 'period'],
        ['?', 'detail'],
        ['esc', 'close'],
      ],
    };
  }

  protected renderBody(width: number, height: number): string[] {
    const view = this.getView();
    if (view.disabled) return this.disabledBody(width);
    if (this.showDetail) return this.detailBody(view, width).slice(0, height);
    return this.metricsBody(view, width, height);
  }

  /**
   * An explicit disabled state: zeroed stat cells would read as a real session
   * that happened to do nothing.
   */
  private disabledBody(width: number): string[] {
    return [
      truncateToWidth(this.theme.fg('warning', ' Metrics collection is disabled for this session.'), width),
      truncateToWidth(this.theme.fg('dim', ` ${DISABLED_ENV}=1 is set, so no log records are produced.`), width),
      truncateToWidth(this.theme.fg('dim', ` Unset ${DISABLED_ENV} and restart Pi to collect metrics.`), width),
    ];
  }

  /**
   * The `?` pane. Sink wiring and the caveats behind each panel live here so the
   * default view can spend its rows on numbers instead of explaining itself.
   */
  private detailBody(view: LogMetricsView, width: number): string[] {
    const content = Math.max(1, width - 1);
    return [
      this.theme.fg('accent', SINK_TITLE),
      ...sinkDetailRows(view.sink, content),
      '',
      this.theme.fg('accent', HISTORY_TITLE),
      ...this.historyDetailRows(view, content),
      ...wrapText(INSTANCE_NOTE, content),
      '',
      this.theme.fg('accent', DETAIL_TITLE),
      labelled('source', 'in-process Pi events', content),
      labelled('scope', 'current session only', content),
      ...wrapText(COLLECTION_NOTE, content),
      '',
      this.theme.fg('accent', 'TOOL COST ATTRIBUTION'),
      ...wrapText(ATTRIBUTION_NOTE, content),
    ].map((line) => pad(` ${line}`, width));
  }

  private metricsBody(view: LogMetricsView, width: number, height: number): string[] {
    const stats = statRows(view.snapshot, width, this.theme);
    if (height <= stats.length) return stats.slice(0, height);

    if (width < MIN_TWO_COLUMN_WIDTH) {
      return [...stats, '', ...this.singleColumnPanels(view, width)].slice(0, height);
    }

    const rightWidth = Math.max(MIN_RIGHT_COLUMN, Math.floor(width * RIGHT_COLUMN_RATIO));
    const leftWidth = Math.max(1, width - rightWidth - 1);

    // Each column reserves one leading space, so rows are built one narrower.
    const leftContent = Math.max(1, leftWidth - 1);
    const rightContent = Math.max(1, rightWidth - 1);
    const left = [
      ...this.findingsPanel(view.snapshot, leftContent),
      '',
      ...this.toolCostPanel(view.snapshot, leftContent),
      '',
      ...this.consumerPanel(leftContent),
    ];
    const right = [
      ...this.burnPanel(rightContent),
      '',
      ...this.errorsPanel(view.snapshot, rightContent),
      '',
      this.theme.fg('accent', SINK_TITLE),
      ...sinkRows(view.sink, rightContent, view.lastDiagnostic),
    ];

    const bodyHeight = Math.max(0, height - stats.length - 1);
    const body = [this.theme.fg('borderMuted', `${'─'.repeat(leftWidth)}┬${'─'.repeat(rightWidth)}`)];
    for (let index = 0; index < bodyHeight; index++) {
      body.push(
        pad(` ${left[index] ?? ''}`, leftWidth) +
          this.theme.fg('borderMuted', '│') +
          pad(` ${right[index] ?? ''}`, rightWidth),
      );
    }
    return [...stats, ...body].slice(0, height);
  }

  private singleColumnPanels(view: LogMetricsView, width: number): string[] {
    return [
      ...this.findingsPanel(view.snapshot, width),
      '',
      ...this.toolCostPanel(view.snapshot, width),
      '',
      ...this.errorsPanel(view.snapshot, width),
      '',
      this.theme.fg('accent', SINK_TITLE),
      ...sinkRows(view.sink, width, view.lastDiagnostic),
    ];
  }
}
