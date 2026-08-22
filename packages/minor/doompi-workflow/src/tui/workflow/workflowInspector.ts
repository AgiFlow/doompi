/**
 * Workflow Space: the `SPC w l` overlay.
 *
 * A doom overlay rather than a hand-rolled frame: the roster owns the left
 * third, the run under the cursor owns the right two thirds, and the chrome is
 * the same frame, breadcrumb and key legend every other doom surface draws.
 *
 * Rendering is pure -- `renderBody(width, height)` reads the last polled
 * snapshot and returns lines with no side effects -- so the surface can be
 * asserted as text without a live terminal.
 */

import { currentWorkflowPosition, type WorkflowProgressJob } from '@agimon-ai/workflow-mcp';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from './doomOverlay.ts';
import { fitTerminalLine } from './overlayText';
import { humanizeDuration } from './workflowStatusRow';

export const WORKFLOW_INSPECTOR_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;

export interface WorkflowInspectorSelection {
  runId?: string;
  runKey: string;
  startedAt: string;
  workspace: string;
}

export interface WorkflowInspectorItem extends WorkflowInspectorSelection {
  displayName: string;
  executionState?: string;
  jobs: WorkflowProgressJob[];
  key: string;
  output: string[];
}

export interface WorkflowInspectorSource {
  list(): Promise<WorkflowInspectorItem[]>;
  output(item: WorkflowInspectorItem): Promise<string[]>;
}

export interface WorkflowInspectorOptions {
  initialKey?: string;
  refreshMs?: number;
}

const TITLE = 'WORKFLOW SPACE';
const BREADCRUMB = 'SPC › w / workflows › l / manage';
const ROSTER_HEADING = 'RUNNING · this session';
const EMPTY_ROSTER = 'No active workflows';
const PROGRESS_HEADING = 'PROGRESS';
const OUTPUT_HEADING = 'OUTPUT · newest last';
const NO_SELECTION = 'Select a workflow to inspect its jobs and output.';
const RUNNING_STATE = 'running';
const PAUSED_STATE = 'paused';
/** Mirrors DoomPi's list-navigation legend without adding a runtime doompi-ui dependency. */
const LIST_NAVIGATION_KEYS = '↑↓';
const FOOTER = `${LIST_NAVIGATION_KEYS} select · PgUp/PgDn page · enter open · esc close`;
const FOOTER_HINTS: readonly (readonly [string, string])[] = [
  [LIST_NAVIGATION_KEYS, 'select'],
  ['PgUp/PgDn', 'page'],
  ['enter', 'open'],
  ['esc', 'close'],
];

const DEFAULT_REFRESH_MS = 750;
const SELECTION_MARKER = '›';
const ELLIPSIS = '…';
/** pi-tui brackets a truncation ellipsis with this; see `fit`. */
const HARD_RESET = '\x1b[0m';
/** A third for the roster, two thirds for the run being read. */
const LIST_PANE_RATIO = 1 / 3;
/** One blank column each side of the divider so neither pane touches it. */
const PANE_GUTTER = 1;
const MIN_PANE_WIDTH = 18;
/** Below this the roster cannot hold a readable name, so the detail takes the body. */
const MIN_TWO_PANE_WIDTH = 48;
/** Each run occupies a name row and a state row beneath it. */
const ROWS_PER_ITEM = 2;
/** Hanging indent for the state row: clears the marker and the glyph. */
const META_INDENT = 4;
/** Rows the roster heading and its spacer take. */
const ROSTER_CHROME_ROWS = 2;
/** The output tail keeps at least this many rows, or it is not worth a divider. */
const MIN_OUTPUT_ROWS = 2;

/** Neither palette name is exported, so take both from the theme's methods. */
type ThemeBg = Parameters<Theme['bg']>[0];
type ThemeColor = Parameters<Theme['fg']>[0];

/**
 * Truncates and pads to an exact column count.
 *
 * `truncateToWidth` wraps its ellipsis in a hard `\x1b[0m`, which would strip a
 * row's background for everything after a clipped name. The theme closes its own
 * colours with `\x1b[39m` and `\x1b[49m`, so the injected resets are dropped.
 */
function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), ELLIPSIS).replaceAll(HARD_RESET, '');
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

function jobGlyph(status: string): string {
  return status === 'completed' ? '✓' : status === 'failed' ? '✗' : '●';
}

function jobColour(status: string): ThemeColor {
  return status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'accent';
}

function progressLines(item: WorkflowInspectorItem, width: number, theme: Theme): string[] {
  const lines: string[] = [];
  for (const job of item.jobs) {
    const position = job.total ? ` · ${(job.index ?? 0) + 1}/${job.total}` : '';
    lines.push(
      truncateToWidth(
        theme.fg(jobColour(job.status), `${jobGlyph(job.status)} ${job.name}`) + theme.fg('dim', position),
        width,
        ELLIPSIS,
      ),
    );
    // Only the running job's steps: every finished job's steps would push the
    // live one off the pane, which is the one thing worth watching.
    if (job.status !== RUNNING_STATE) continue;
    for (const step of job.steps) {
      const stepColour: ThemeColor =
        step.status === 'failed' ? 'error' : step.status === RUNNING_STATE ? 'muted' : 'dim';
      lines.push(truncateToWidth(theme.fg(stepColour, `   ${jobGlyph(step.status)} ${step.name}`), width, ELLIPSIS));
    }
  }
  return lines;
}

function detailLines(item: WorkflowInspectorItem | undefined, width: number, height: number, theme: Theme): string[] {
  if (!item) return [theme.fg('dim', NO_SELECTION)];

  const position = currentWorkflowPosition(item.jobs);
  const elapsed = humanizeDuration(Math.max(0, Date.now() - Date.parse(item.startedAt)));
  const executionState = item.executionState ?? RUNNING_STATE;
  const stateColour: ThemeColor = executionState === PAUSED_STATE ? 'warning' : 'dim';
  const lines = [
    rightAligned(
      `${theme.fg('accent', '●')} ${theme.bold(item.displayName)}`,
      theme.fg(stateColour, executionState),
      width,
    ),
    truncateToWidth(theme.fg('dim', `${item.runKey} · ${item.workspace} · ${elapsed}`), width, ELLIPSIS),
    position
      ? truncateToWidth(
          `${theme.fg('accent', position.job)}${position.step ? theme.fg('muted', ` · ${position.step}`) : ''}`,
          width,
          ELLIPSIS,
        )
      : theme.fg('dim', 'starting'),
    '',
    theme.fg('dim', PROGRESS_HEADING),
  ];

  // The output tail claims its rows first: progress is a list that can be paged
  // to by opening the run, while the tail is the only live signal on screen.
  const reservedOutput = item.output.length > 0 ? MIN_OUTPUT_ROWS + 1 : 0;
  const progressRoom = Math.max(0, height - lines.length - reservedOutput);
  lines.push(...progressLines(item, width, theme).slice(0, progressRoom));

  if (item.output.length > 0 && height - lines.length >= MIN_OUTPUT_ROWS) {
    lines.push('', theme.fg('dim', OUTPUT_HEADING));
    const outputRoom = Math.max(0, height - lines.length);
    // Captured output carries the run's own colour, so it is fitted by the
    // escape-preserving path: `fit` below drops hard resets, and a capture that
    // lost its reset bleeds its colour through the divider and down the pane.
    lines.push(...item.output.slice(-outputRoom).map((line) => fitTerminalLine(line, width)));
  }

  return lines.slice(0, height);
}

export class WorkflowInspectorComponent extends DoomOverlay {
  private bodyHeight = 8;
  private completed = false;
  private error: string | undefined;
  private items: WorkflowInspectorItem[] = [];
  private refreshActive = false;
  private selected = 0;
  private selectedKey: string | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly source: WorkflowInspectorSource,
    private readonly done: (selection: WorkflowInspectorSelection | undefined) => void,
    options: WorkflowInspectorOptions = {},
  ) {
    super(tui, theme);
    this.selectedKey = options.initialKey;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), options.refreshMs ?? DEFAULT_REFRESH_MS);
    this.timer.unref?.();
  }

  private async refresh(): Promise<void> {
    if (this.refreshActive || this.completed) return;
    this.refreshActive = true;
    try {
      const previousKey = this.items[this.selected]?.key ?? this.selectedKey;
      const items = await this.source.list();
      if (this.completed) return;
      const preserved = previousKey ? items.findIndex((item) => item.key === previousKey) : -1;
      this.items = items;
      this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, items.length - 1));
      this.selectedKey = items[this.selected]?.key;
      const selected = items[this.selected];
      if (selected) selected.output = await this.source.output(selected);
      this.error = undefined;
      if (!this.completed) this.tui.requestRender();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
      if (!this.completed) this.tui.requestRender();
    } finally {
      this.refreshActive = false;
    }
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
    this.selectedKey = this.items[this.selected]?.key;
    void this.refreshSelectedOutput();
    this.tui.requestRender();
  }

  private async refreshSelectedOutput(): Promise<void> {
    const selected = this.items[this.selected];
    if (!selected || this.completed) return;
    try {
      selected.output = await this.source.output(selected);
      this.error = undefined;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    if (!this.completed && selected.key === this.selectedKey) this.tui.requestRender();
  }

  private finish(selection: WorkflowInspectorSelection | undefined): void {
    if (this.completed) return;
    this.completed = true;
    clearInterval(this.timer);
    this.done(selection);
  }

  close(): void {
    this.finish(undefined);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.finish(undefined);
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || data === 'j') {
      this.move(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.move(-this.rosterCapacity());
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.move(this.rosterCapacity());
      return;
    }
    if (matchesKey(data, 'enter')) {
      const selected = this.items[this.selected];
      if (selected) {
        this.finish({
          ...(selected.runId ? { runId: selected.runId } : {}),
          runKey: selected.runKey,
          startedAt: selected.startedAt,
          workspace: selected.workspace,
        });
      }
    }
  }

  /** Runs the roster can draw, which is also what a page key moves by. */
  private rosterCapacity(): number {
    return Math.max(1, Math.floor((this.bodyHeight - ROSTER_CHROME_ROWS) / ROWS_PER_ITEM));
  }

  private current(): WorkflowInspectorItem | undefined {
    if (this.items.length === 0) return undefined;
    return this.items[Math.min(this.selected, this.items.length - 1)];
  }

  protected getChrome(): DoomOverlayChrome {
    const selected = this.current();
    const summary = selected
      ? `${selected.displayName} · ${selected.executionState ?? RUNNING_STATE}`
      : 'no active workflows';
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: `${this.items.length} running · ${summary}`,
      footer: FOOTER,
      footerHints: FOOTER_HINTS,
      footerRight:
        this.items.length > 0 ? `${Math.min(this.selected, this.items.length - 1) + 1}/${this.items.length}` : 'empty',
    };
  }

  protected renderBody(width: number, height: number): string[] {
    this.bodyHeight = height;
    const detailFor = (paneWidth: number): string[] =>
      this.error
        ? [this.theme.fg('warning', `Unable to refresh workflows: ${this.error}`)]
        : detailLines(this.current(), paneWidth, height, this.theme);

    // Too narrow for two useful columns: the detail takes the whole body rather
    // than shredding both panes into stubs.
    if (width < MIN_TWO_PANE_WIDTH) return detailFor(width).slice(0, height);

    const leftWidth = Math.max(MIN_PANE_WIDTH, Math.floor((width - 1) * LIST_PANE_RATIO));
    const rightWidth = Math.max(1, width - leftWidth - 1);
    const leftContent = Math.max(1, leftWidth - PANE_GUTTER);
    const rightContent = Math.max(1, rightWidth - PANE_GUTTER);

    const left = this.rosterLines(leftContent);
    const right = detailFor(rightContent);
    const divider = this.theme.fg('borderMuted', '│');
    return Array.from({ length: height }, (_, index) => {
      // The roster keeps `fit`, whose reset stripping protects its row
      // backgrounds; the detail pane has none and may carry captured colour.
      const row = `${fit(left[index] ?? '', leftContent)} ${divider} ${fitTerminalLine(
        right[index] ?? '',
        rightContent,
      )}`;
      return truncateToWidth(row, width, ELLIPSIS);
    });
  }

  private rosterLines(width: number): string[] {
    const lines = [this.theme.bold(ROSTER_HEADING), ''];
    if (this.items.length === 0) {
      lines.push(this.theme.fg('dim', EMPTY_ROSTER));
      return lines;
    }

    // Two rows per run: at a third of the width a single row left the name with
    // a handful of columns once the stage took its share.
    const budget = this.rosterCapacity();
    const active = Math.min(this.selected, this.items.length - 1);
    const start = Math.max(0, Math.min(active - budget + 1, Math.max(0, this.items.length - budget)));
    for (const [offset, item] of this.items.slice(start, start + budget).entries()) {
      const current = start + offset === active;
      const paused = item.executionState === PAUSED_STATE;
      const marker = current ? this.theme.fg('accent', SELECTION_MARKER) : ' ';
      const glyph = this.theme.fg(paused ? 'warning' : 'accent', '●');
      const name = current ? this.theme.bold(item.displayName) : item.displayName;
      const stage = paused ? PAUSED_STATE : (currentWorkflowPosition(item.jobs)?.job ?? 'starting');
      const heading = `${marker} ${glyph} ${name}`;
      const meta = `${' '.repeat(META_INDENT)}${this.theme.fg(paused ? 'warning' : 'dim', stage)}`;
      const background: ThemeBg = current ? 'selectedBg' : 'userMessageBg';
      for (const row of [heading, meta]) lines.push(this.theme.bg(background, fit(row, width)));
    }
    return lines;
  }

  /** Overridden: a repaint request is also the cue to re-read the registry. */
  invalidate(): void {
    void this.refresh();
  }

  dispose(): void {
    if (this.completed) return;
    this.completed = true;
    clearInterval(this.timer);
  }
}
