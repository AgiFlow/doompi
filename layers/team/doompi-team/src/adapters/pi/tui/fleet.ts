/**
 * The fleet inspector overlay: a roster of this session's async runs, plus a
 * scrollable detail/transcript pane and runtime controls for the selected one.
 *
 * NOT A PORT - THE FIX IS THE POINT:
 * The predecessor (`doom-pi-subagents/src/tui/fleet.ts`) owned a private
 * `setInterval(750ms)` whose handler unconditionally nulled its own transcript
 * cache (`invalidate()`), so every tick re-read and re-parsed the selected
 * run's whole transcript file regardless of whether anything had changed.
 * This version registers with `PollScheduler` instead of owning a timer, and
 * NEVER blanks `transcriptCache` on a tick. A tick stats only the selected
 * transcript and requests a repaint when its size or modification time changes.
 * `renderedTranscript()` then uses the same fingerprint to decide whether the
 * next render needs one content read. Ctrl+R remains the deliberate manual
 * cache-clearing path.
 *
 * There is also no foreground-run concept here (doom-team is async-only - see
 * `spawnHandshake.ts`'s header), so every roster item is an async run. Roster
 * state comes from `AsyncJobTrackerContract`, the package's one source of truth for
 * run state; the fuller per-run detail a tracker record does not carry
 * (steps, summary) comes from `readAsyncRunStatus` (`statusReader.ts`), read
 * lazily only for the SELECTED item when the detail pane actually needs it,
 * not for the whole roster on every tick.
 *
 * DESIGN PATTERNS:
 * - The scheduler subscription's `run()` diffs the roster and selected
 *   transcript fingerprint against the last values it saw, matching
 *   `PollSubscription`'s "return true only on real work" contract so idle
 *   backoff still applies when nothing in the fleet is moving
 * - Controls always list every action, unavailable ones dimmed rather than
 *   hidden, so the key map never shifts under the user
 *
 * Child transcripts are written directly from Pi SDK events by the detached
 * runner. The exact artifact path is persisted in status.json so non-default
 * artifact policies remain readable here.
 */

import * as fs from 'node:fs';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import { type ExtensionContext, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { AsyncRunStatus } from '../../runs/background/asyncExecution';
import type { TrackedAsyncJobsContract, TrackedAsyncJob } from '../../asyncJobTracker';
import { readAsyncRunStatus } from '../../statusReader';
import { formatDuration, formatModelThinking, formatTokens } from './formatters';
import type { PollSchedulerContract } from '../../pollScheduler';
import { agentSystemPromptFingerprint, fieldRow, readAgentSystemPrompt, renderAgentView } from './fleetAgentView';
import {
  type FleetTranscriptRender,
  type FleetTranscriptTail,
  type FleetTranscriptVerbosity,
  readFleetTranscriptTail,
  renderFleetTranscript,
} from './fleetTranscript';

const DEFAULT_REFRESH_INTERVAL_MS = 750;
const MIN_DETAIL_BODY_LINES = 15;
const FIELD_FALLBACK = '—';
const POLL_SUBSCRIBER_ID = 'tui-fleet';
const ROSTER_ROWS_PER_ITEM = 2;
/** Indent under `› ● `, so the state line hangs under the agent name. */
const ROSTER_META_INDENT = '    ';

/** Which question the detail pane is answering. See `fleetAgentView.ts`'s header. */
export type FleetDetailTab = 'transcript' | 'agent';

type Theme = ExtensionContext['ui']['theme'];
export interface FleetItem {
  key: string;
  runId: string;
  agent: string;
  state: string;
  updatedAt: number;
  /** Absent until the child writes its first status; the roster then shows no age. */
  startedAt: number | undefined;
  job: TrackedAsyncJob;
}

export interface FleetSnapshot {
  items: FleetItem[];
}

export type FleetActionName = 'interrupt' | 'stop' | 'resume' | 'steer';

export interface FleetActionRequest {
  action: FleetActionName;
  id: string;
  message?: string;
}

export interface FleetActionResult {
  status: string;
  detail?: string;
}

export type FleetActionDispatcher = (request: FleetActionRequest) => Promise<FleetActionResult>;

export interface FleetViewOptions {
  refreshMs?: number;
  initialKey?: string;
  markdownTheme?: MarkdownTheme;
  /** Injected so the overlay can be asserted on its emitted payload in tests. */
  dispatchAction?: FleetActionDispatcher;
}

const CONTROL_ORDER: readonly FleetActionName[] = ['interrupt', 'stop', 'resume', 'steer'];
const CONTROL_KEY: Record<FleetActionName, string> = { interrupt: 'i', stop: 'x', resume: 'r', steer: 'm' };
/**
 * Short inline qualifier for a control, or undefined where the verb is enough.
 *
 * Collapsed from a full sentence per action when the controls moved to one
 * line. What survives is only what changes a decision at the moment of
 * pressing the key - above all that `stop` cannot be undone, which is the one
 * hint whose loss would cost a user a run.
 */
const CONTROL_HINT: Record<FleetActionName, string | undefined> = {
  interrupt: 'turn',
  stop: 'run, final',
  resume: undefined,
  steer: undefined,
};
const CONTROL_BY_KEY = new Map<string, FleetActionName>(CONTROL_ORDER.map((action) => [CONTROL_KEY[action], action]));
/**
 * Run-state tokens as the tracker writes them. Named once because availability
 * checks and glyph rendering both branch on them, and a typo in either place
 * fails silently as "unknown state".
 */
const RUN_STATE = {
  running: 'running',
  queued: 'queued',
  pending: 'pending',
  paused: 'paused',
  stopped: 'stopped',
  complete: 'complete',
  completed: 'completed',
  failed: 'failed',
} as const;

const LIVE_STATES = new Set<string>([RUN_STATE.running, RUN_STATE.queued]);
const RESUMABLE_STATES = new Set<string>([RUN_STATE.paused, RUN_STATE.complete, RUN_STATE.completed, RUN_STATE.failed]);

function controlAvailability(item: FleetItem | undefined): Record<FleetActionName, boolean> {
  if (!item) return { interrupt: false, stop: false, resume: false, steer: false };
  const live = LIVE_STATES.has(item.state);
  return {
    interrupt: live,
    stop: live,
    resume: RESUMABLE_STATES.has(item.state),
    steer: item.state === RUN_STATE.running,
  };
}

/**
 * How long the run has been going: to now while it is live, to its last
 * status write once it is not. Undefined until the child reports a start.
 */
function runAge(item: FleetItem, now: number): string | undefined {
  if (item.startedAt === undefined) return undefined;
  const end = LIVE_STATES.has(item.state) ? now : Math.max(item.updatedAt, item.startedAt);
  return formatDuration(Math.max(0, end - item.startedAt));
}

function unavailableReason(action: FleetActionName, item: FleetItem | undefined): string {
  if (!item) return `${action} unavailable · no run is selected`;
  if (action === 'resume') {
    return `resume unavailable · ${item.runId} is ${item.state}; resume targets paused, completed, or failed runs`;
  }
  return `${action} unavailable · ${item.runId} is ${item.state}`;
}

/** One tracked job per roster row, preserving tracker insertion order across refreshes. */
export function collectFleetSnapshot(tracker: TrackedAsyncJobsContract): FleetSnapshot {
  const items = tracker.list().map((job): FleetItem => ({
    key: job.runId,
    runId: job.runId,
    agent: job.agent ?? job.runId.slice(0, 8),
    state: job.status ?? 'unknown',
    updatedAt: job.updatedAt ?? job.startedAt ?? 0,
    startedAt: job.startedAt,
    job,
  }));
  return { items };
}

/** A short string that changes iff anything a roster row displays changed. */
function rosterRenderKey(snapshot: FleetSnapshot): string {
  return snapshot.items
    .map((item) => `${item.runId}:${item.state}:${item.updatedAt}:${item.job.activityState ?? ''}`)
    .join('|');
}

function statusGlyph(state: string, theme: Theme): string {
  if (state === RUN_STATE.running) return theme.fg('accent', '●');
  if (state === RUN_STATE.queued || state === RUN_STATE.pending) return theme.fg('muted', '◦');
  if (state === RUN_STATE.complete || state === RUN_STATE.completed) return theme.fg('success', '✓');
  if (state === RUN_STATE.paused || state === RUN_STATE.stopped) return theme.fg('warning', '■');
  return theme.fg('error', '✗');
}

/**
 * What the selected run is doing right now.
 *
 * Every value here was already being written to status.json and none of it was
 * being shown, which is why the pane could be watched for minutes without
 * telling you whether anything was happening. `Doing` and `Usage` keep their
 * rows even when empty so the header height does not change under a running
 * run and bounce the transcript below it.
 */
function statusHeaderLines(
  item: FleetItem,
  status: AsyncRunStatus | undefined,
  width: number,
  theme: Theme,
  now: number,
): string[] {
  const identity = [
    item.runId.slice(0, 12),
    status?.agent ?? item.agent,
    status?.model ? formatModelThinking(status.model) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  const elapsed =
    status?.startedAt !== undefined ? formatDuration((status.endedAt ?? now) - status.startedAt) : undefined;
  const usage = [
    status?.toolCount ? `${status.toolCount} tools` : undefined,
    status?.tokens ? `${formatTokens(status.tokens)} tokens` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  const rows: Array<[string, string]> = [
    ['Run', identity],
    ['State', [item.state, status?.activityState, elapsed].filter((part): part is string => Boolean(part)).join(' · ')],
    ['Doing', status?.currentTool ?? FIELD_FALLBACK],
    ['Usage', usage || FIELD_FALLBACK],
  ];
  if (status?.attentionReason) rows.push(['Needs', status.attentionReason]);
  if (status?.error) rows.push(['Error', status.error]);
  if (status?.summary) rows.push(['Result', status.summary]);
  return rows.map(([label, value]) => fieldRow(label, value, width, theme));
}

/**
 * Runtime controls on one line.
 *
 * Every action is still listed, unavailable ones dimmed rather than hidden, so
 * the key map never shifts under the user. The per-action hints moved to the
 * footer legend: five rows of them cost the transcript a third of the pane to
 * restate what the footer already says.
 */
function controlLine(item: FleetItem | undefined, width: number, theme: Theme): string {
  const availability = controlAvailability(item);
  const parts = CONTROL_ORDER.map((action) => {
    const hint = CONTROL_HINT[action];
    const body = `${action}${hint ? ` (${hint})` : ''}`;
    return availability[action]
      ? `${theme.fg('accent', CONTROL_KEY[action])} ${body}`
      : theme.fg('dim', `${CONTROL_KEY[action]} ${body}`);
  });
  return truncateToWidth(`  ${parts.join(theme.fg('dim', ' · '))}`, width);
}

function tabStrip(tab: FleetDetailTab, verbosity: FleetTranscriptVerbosity, width: number, theme: Theme): string {
  const label = (name: FleetDetailTab): string =>
    name === tab ? theme.fg('accent', theme.bold(`[ ${name} ]`)) : theme.fg('dim', `  ${name}  `);
  const right = theme.fg('dim', tab === 'transcript' ? `p agent · o ${verbosity}` : 'p transcript');
  return rightAligned(`  ${label('transcript')}${label('agent')}`, right, width);
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

/**
 * Size and mtime of a transcript, for the poll tick.
 *
 * A tick may stat but must never read (see the module header), so this is
 * deliberately the cheapest thing that still changes when the file grows.
 */
function transcriptFingerprint(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** Rendered agent tab, cached so scrolling a long prompt does not re-render its markdown. */
interface FleetAgentCache {
  runId: string;
  fingerprint: string;
  width: number;
  lines: string[];
}

export class SubagentFleetComponent extends DoomOverlay {
  private snapshot: FleetSnapshot = { items: [] };
  private lastRenderKey = '';
  private selected = 0;
  private selectedKey: string | undefined;
  private detailScroll = 0;
  private detailAutoFollow = true;
  private detailLineCount = 0;
  private detailViewportHeight = 8;
  private bodyHeight = 8;
  private steerDraft: string | undefined;
  private actionNotice: string | undefined;
  private detailTab: FleetDetailTab = 'transcript';
  private verbosity: FleetTranscriptVerbosity = 'compact';
  private transcriptTail: FleetTranscriptTail | undefined;
  private transcriptRender: FleetTranscriptRender | undefined;
  private agentCache: FleetAgentCache | undefined;
  private disposed = false;
  private readonly unregister: () => void;
  private readonly markdownTheme: MarkdownTheme;
  private readonly scheduler: PollSchedulerContract;
  private readonly tracker: TrackedAsyncJobsContract;
  private readonly done: (result: undefined) => void;
  private readonly options: FleetViewOptions;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    scheduler: PollSchedulerContract,
    tracker: TrackedAsyncJobsContract,
    done: (result: undefined) => void,
    options: FleetViewOptions = {},
  ) {
    super(tui, theme);
    this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
    this.scheduler = scheduler;
    this.tracker = tracker;
    this.done = done;
    this.options = options;
    this.selectedKey = options.initialKey;
    this.refresh();
    this.lastRenderKey = this.pollRenderKey();
    this.unregister = this.scheduler.register({
      id: POLL_SUBSCRIBER_ID,
      intervalMs: options.refreshMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      run: () => this.onTick(),
    });
  }

  /**
   * One scheduler tick. The tracker read is in memory and only the selected
   * transcript is statted. Transcript contents remain render-owned and cached.
   */
  private onTick(): boolean {
    if (this.disposed) return false;
    this.refresh();
    const renderKey = this.pollRenderKey();
    if (renderKey === this.lastRenderKey) return false;
    this.lastRenderKey = renderKey;
    this.tui.requestRender();
    return true;
  }

  private pollRenderKey(): string {
    const selected = this.snapshot.items[this.selected];
    if (!selected) return `${rosterRenderKey(this.snapshot)}::none`;
    const transcriptPath = readAsyncRunStatus(selected.runId)?.transcriptPath;
    const transcriptKey = transcriptPath ? `${transcriptPath}:${transcriptFingerprint(transcriptPath)}` : 'none';
    // The live status header moves on values the roster row does not carry, so
    // a tick that only changes what the run is DOING still has to repaint.
    const job = selected.job;
    const activity = `${job.currentTool ?? ''}:${job.toolCount ?? 0}:${job.tokens ?? 0}`;
    return `${rosterRenderKey(this.snapshot)}::${selected.runId}:${transcriptKey}:${activity}`;
  }

  private refresh(): void {
    const previousKey = this.snapshot.items[this.selected]?.key ?? this.selectedKey;
    this.snapshot = collectFleetSnapshot(this.tracker);
    const preserved = previousKey ? this.snapshot.items.findIndex((item) => item.key === previousKey) : -1;
    this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.snapshot.items.length - 1));
    this.selectedKey = this.snapshot.items[this.selected]?.key;
  }

  private moveSelection(delta: number): void {
    if (this.snapshot.items.length === 0) return;
    this.selected = Math.max(0, Math.min(this.snapshot.items.length - 1, this.selected + delta));
    this.selectedKey = this.snapshot.items[this.selected]?.key;
    this.lastRenderKey = this.pollRenderKey();
    this.detailAutoFollow = true;
    this.tui.requestRender();
  }

  private scrollDetail(delta: number): void {
    const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
    this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll + delta));
    this.detailAutoFollow = this.detailScroll >= maxScroll;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.steerDraft !== undefined) return this.handleSteerInput(data);
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'q')) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.shift('k'))) return this.scrollDetail(-1);
    if (matchesKey(data, Key.shift('j'))) return this.scrollDetail(1);
    if (matchesKey(data, 'up') || matchesKey(data, 'k')) return this.moveSelection(-1);
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) return this.moveSelection(1);
    if (matchesKey(data, 'pageUp')) return this.scrollDetail(-this.detailViewportHeight);
    if (matchesKey(data, 'pageDown')) return this.scrollDetail(this.detailViewportHeight);
    if (matchesKey(data, 'p')) return this.toggleTab();
    if (matchesKey(data, 'o')) return this.toggleVerbosity();
    if (matchesKey(data, 'ctrl+r')) {
      // Manual refresh: the one deliberate cache-clearing path. Distinct from
      // every scheduler tick, which must not do this - see the module header.
      this.clearCaches();
      this.refresh();
      this.tui.requestRender();
      return;
    }
    const action = CONTROL_BY_KEY.get(data.toLowerCase());
    if (action) this.triggerControl(action);
  }

  private clearCaches(): void {
    this.transcriptTail = undefined;
    this.transcriptRender = undefined;
    this.agentCache = undefined;
  }

  private toggleTab(): void {
    this.detailTab = this.detailTab === 'transcript' ? 'agent' : 'transcript';
    // A transcript is read newest-last and a prompt is read from the top, so
    // each tab lands where its own content starts being useful.
    this.detailScroll = 0;
    this.detailAutoFollow = this.detailTab === 'transcript';
    this.tui.requestRender();
  }

  private toggleVerbosity(): void {
    this.verbosity = this.verbosity === 'compact' ? 'full' : 'compact';
    // No cache clearing needed: `renderFleetTranscript` treats a verbosity
    // change as a global one and re-renders every block itself.
    this.tui.requestRender();
  }

  private handleSteerInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.steerDraft = undefined;
      this.setNotice('steer cancelled · no message sent');
      return;
    }
    if (data === '\r' || data === '\n') {
      const message = (this.steerDraft ?? '').trim();
      this.steerDraft = undefined;
      const item = this.snapshot.items[this.selected];
      if (!item || !message) {
        this.setNotice('steer cancelled · a non-empty message is required');
        return;
      }
      void this.dispatch({ action: 'steer', id: item.runId, message });
      return;
    }
    if (data === '\x7f' || data === '\b') {
      this.steerDraft = (this.steerDraft ?? '').slice(0, -1);
      this.tui.requestRender();
      return;
    }
    if (data.length === 1 && data >= ' ') {
      this.steerDraft = `${this.steerDraft ?? ''}${data}`;
      this.tui.requestRender();
    }
  }

  private triggerControl(action: FleetActionName): void {
    const item = this.snapshot.items[this.selected];
    if (!controlAvailability(item)[action]) {
      this.setNotice(unavailableReason(action, item));
      return;
    }
    if (!item) return;
    if (action === 'steer') {
      this.steerDraft = '';
      this.tui.requestRender();
      return;
    }
    void this.dispatch({ action, id: item.runId });
  }

  private async dispatch(request: FleetActionRequest): Promise<void> {
    const dispatchAction = this.options.dispatchAction;
    if (!dispatchAction) {
      this.setNotice(`${request.action} ${request.id} · unavailable · no subagent control channel is attached`);
      return;
    }
    this.setNotice(`${request.action} ${request.id} · dispatching…`);
    try {
      const result = await dispatchAction(request);
      if (this.disposed) return;
      this.setNotice(`${request.action} ${request.id} · ${result.status}${result.detail ? ` · ${result.detail}` : ''}`);
    } catch (cause) {
      if (this.disposed) return;
      this.setNotice(
        `${request.action} ${request.id} · failed · ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private setNotice(notice: string): void {
    this.actionNotice = notice;
    this.tui.requestRender();
  }

  /**
   * Two lines per run: the agent name, then its state and age beneath it. The
   * agent name is what a reader picks a row by, and sharing one line with the
   * state truncated it first on a roster pane this narrow.
   */
  private rosterLines(width: number, now: number): string[] {
    if (this.snapshot.items.length === 0) return [this.theme.fg('dim', 'No tracked runs')];
    const perPage = this.rosterPageSize();
    const start = Math.max(0, Math.min(this.selected - perPage + 1, Math.max(0, this.snapshot.items.length - perPage)));
    const lines: string[] = [];
    for (const [offset, item] of this.snapshot.items.slice(start, start + perPage).entries()) {
      const index = start + offset;
      const current = index === this.selected;
      const marker = current ? this.theme.fg('accent', '›') : ' ';
      const agent = this.theme.fg(agentIdentityColor(item.runId), current ? this.theme.bold(item.agent) : item.agent);
      const age = runAge(item, now);
      lines.push(fit(`${marker} ${statusGlyph(item.state, this.theme)} ${agent}`, width));
      lines.push(
        fit(`${ROSTER_META_INDENT}${this.theme.fg('dim', age ? `${item.state} · ${age}` : item.state)}`, width),
      );
    }
    return lines;
  }

  /** How many runs fit the roster pane, at `ROSTER_ROWS_PER_ITEM` lines each. */
  private rosterPageSize(): number {
    return Math.max(1, Math.floor(this.bodyHeight / ROSTER_ROWS_PER_ITEM));
  }

  /**
   * Reads and formats the selected run's transcript, cached by content
   * fingerprint. Only invoked from `render()`, never from a poll tick - so a
   * disk read only happens when the pane is actually about to be painted with
   * new content, not on a fixed clock.
   */
  private renderedTranscript(status: AsyncRunStatus | undefined, width: number): { events: number; body: string[] } {
    const target = status?.transcriptPath;
    if (!target) {
      this.transcriptTail = undefined;
      this.transcriptRender = undefined;
      return { events: 0, body: [] };
    }
    // Resuming is what keeps this proportional to what arrived rather than to
    // what the file holds; the returned tail supersedes the one passed in.
    const previous = this.transcriptTail?.path === target ? this.transcriptTail : undefined;
    const tail = readFleetTranscriptTail(target, previous);
    this.transcriptTail = tail;
    const render = renderFleetTranscript(
      tail,
      width,
      this.theme,
      this.markdownTheme,
      { cwd: status?.cwd, verbosity: this.verbosity },
      previous ? this.transcriptRender : undefined,
    );
    this.transcriptRender = render;
    return { events: tail.events.length, body: render.lines };
  }

  /**
   * The agent tab, cached on the prompt's own fingerprint.
   *
   * A recorded system prompt is kilobytes of markdown that never changes for
   * the life of a run, so rendering it once per (run, width) rather than once
   * per keypress is what makes scrolling it usable.
   */
  private renderedAgent(item: FleetItem, status: AsyncRunStatus | undefined, width: number): string[] {
    const fingerprint = agentSystemPromptFingerprint(status);
    if (
      this.agentCache &&
      this.agentCache.runId === item.runId &&
      this.agentCache.fingerprint === fingerprint &&
      this.agentCache.width === width
    ) {
      return this.agentCache.lines;
    }
    const lines = renderAgentView({
      status,
      state: item.state,
      agent: item.agent,
      runId: item.runId,
      prompt: readAgentSystemPrompt(status),
      width,
      theme: this.theme,
      markdownTheme: this.markdownTheme,
    });
    this.agentCache = { runId: item.runId, fingerprint, width, lines };
    return lines;
  }

  private wrappedDetail(selected: FleetItem | undefined, status: AsyncRunStatus | undefined, width: number): string[] {
    if (!selected) {
      return ['No tracked runs.', '', 'New runs appear here automatically while this inspector remains open.'];
    }
    if (this.detailTab === 'agent') return this.renderedAgent(selected, status, width);
    const { events, body } = this.renderedTranscript(status, width);
    if (events > 0) return body;
    const transcriptState = !status
      ? 'Transcript unavailable. No run status was found, so there is no transcript path to read.'
      : !status.transcriptPath
        ? 'Transcript unavailable. Artifacts were disabled for this run, so nothing was recorded.'
        : this.transcriptTail?.warning
          ? 'Transcript unavailable. The transcript artifact is missing or unreadable.'
          : 'No transcript yet.';
    const lines: string[] = [];
    for (const line of wrapTextWithAnsi(transcriptState, Math.max(1, width))) lines.push(line);
    return lines;
  }

  protected getChrome(): DoomOverlayChrome {
    const selected = this.snapshot.items[this.selected];
    const position = this.snapshot.items.length ? `${this.selected + 1}/${this.snapshot.items.length}` : '0/0';
    return {
      title: 'AGENT RUNS',
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: 'SPC › a / agents',
      headerRight: selected
        ? `${statusGlyph(selected.state, this.theme)} ${this.theme.fg(agentIdentityColor(selected.runId), selected.agent)} · ${selected.state}`
        : 'no runs',
      // The per-run controls are listed in the pane itself, next to the state
      // they act on; repeating them here would cost the keys that are not.
      footer: [
        `${DOOM_NAVIGATION_KEYS.list} select`,
        `${DOOM_NAVIGATION_KEYS.detail} scroll`,
        'p agent',
        'o detail',
        'Ctrl+R refresh',
        'Esc close',
      ].join(' · '),
      footerRight: position,
    };
  }

  protected renderBody(width: number, height: number): string[] {
    const transientRows = (this.steerDraft !== undefined ? 2 : 0) + (this.actionNotice !== undefined ? 1 : 0);
    const mainHeight = Math.max(0, height - transientRows);
    const narrow = width < 36;
    const rosterHeight = narrow ? Math.max(1, Math.floor((mainHeight - 1) * 0.35)) : mainHeight;
    const detailPaneHeight = narrow ? Math.max(0, mainHeight - rosterHeight - 1) : mainHeight;
    this.bodyHeight = rosterHeight;
    const rosterPane = narrow ? width : Math.max(22, Math.min(46, Math.floor((width - 1) * 0.38)));
    // Side by side, each pane gives up a column to the divider's gutters.
    const rosterWidth = narrow ? width : Math.max(1, rosterPane - 1);
    const detailWidth = narrow ? width : Math.max(1, width - rosterWidth - 3);
    const now = Date.now();
    const roster = this.rosterLines(rosterWidth, now);
    const selected = this.snapshot.items[this.selected];
    // One status read per paint, shared by the header and the detail body.
    const status = selected ? readAsyncRunStatus(selected.runId) : undefined;
    const body = this.wrappedDetail(selected, status, detailWidth);
    // The agent tab is its own self-describing document, so the live status
    // header would only repeat what it already states in full.
    const fixedHeader =
      selected && this.detailTab === 'transcript'
        ? [
            ...statusHeaderLines(selected, status, detailWidth, this.theme, now),
            '',
            controlLine(selected, detailWidth, this.theme),
            tabStrip(this.detailTab, this.verbosity, detailWidth, this.theme),
          ]
        : selected
          ? [tabStrip(this.detailTab, this.verbosity, detailWidth, this.theme)]
          : [];
    const fixedBudget = detailPaneHeight - MIN_DETAIL_BODY_LINES;
    const detailHeader = fixedBudget >= fixedHeader.length ? fixedHeader : [];
    this.detailViewportHeight = Math.max(1, detailPaneHeight - detailHeader.length);
    this.detailLineCount = body.length;
    const maxDetailScroll = Math.max(0, body.length - this.detailViewportHeight);
    if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
    else if (this.detailScroll > maxDetailScroll) this.detailScroll = maxDetailScroll;
    const visibleDetails = [
      ...detailHeader,
      ...body.slice(this.detailScroll, this.detailScroll + this.detailViewportHeight),
    ];

    const lines: string[] = [];
    if (narrow) {
      for (let index = 0; index < rosterHeight; index++) lines.push(fit(roster[index] ?? '', width));
      if (mainHeight > rosterHeight) lines.push(this.theme.fg('borderMuted', '─'.repeat(width)));
      for (let index = 0; index < detailPaneHeight; index++) lines.push(fit(visibleDetails[index] ?? '', width));
    } else {
      for (let index = 0; index < mainHeight; index++) {
        lines.push(
          `${fit(roster[index] ?? '', rosterWidth)} ${this.theme.fg('borderMuted', '│')} ${fit(
            visibleDetails[index] ?? '',
            detailWidth,
          )}`,
        );
      }
    }
    if (this.steerDraft !== undefined) {
      const steerLines = [
        ` ${this.theme.fg('accent', 'STEER MESSAGE')} ${this.theme.fg('dim', `· run ${selected?.runId ?? FIELD_FALLBACK}`)}`,
        ` ${this.theme.fg('accent', '❯')} ${this.steerDraft}▌`,
      ].map((line) => truncateToWidth(line, width));
      lines.push(...steerLines);
    }
    if (this.actionNotice !== undefined) {
      lines.push(fit(` ${this.theme.fg('muted', this.actionNotice)}`, width));
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }

  /**
   * `Component`'s required "re-render from scratch" hook - the host calls
   * this on a theme change, not on a timer. Distinct from a poll tick (which
   * must NOT do this, see the module header): this is an explicit, external
   * signal that cached state is stale, the same category as Ctrl+R.
   */
  invalidate(): void {
    this.clearCaches();
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.unregister();
  }
}

/** Opens the fleet overlay. `scheduler`/`tracker` are resolved by the caller (see `register.ts`) from the live container, not constructed here. */
export async function openSubagentFleet(
  ctx: ExtensionContext,
  scheduler: PollSchedulerContract,
  tracker: TrackedAsyncJobsContract,
  options: FleetViewOptions = {},
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new SubagentFleetComponent(tui, theme, scheduler, tracker, done, options),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
