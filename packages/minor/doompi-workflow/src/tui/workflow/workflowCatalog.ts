/**
 * The `SPC w l` board: every workflow this repository defines, with the cursor
 * workflow's parsed detail beside it and `r` to launch it.
 *
 * WHY NOT `workflowPicker.ts`:
 * That surface answers "which one", hands a value back, and closes - which is
 * what `SPC w c` recovery still needs. This one answers "what is this workflow,
 * and do I want to run it", so the detail has to be on screen next to the list
 * rather than behind a selection. The picker stays for the pick-and-return case
 * rather than growing a second mode.
 *
 * DESIGN PATTERNS:
 * - Detail is loaded through an injected loader, so parsing a workflow file
 *   stays out of the TUI and the surface is assertable as text. Loaded on
 *   demand for the cursor row and cached by row key: a repository with fifty
 *   workflows must not parse fifty files to draw one pane
 * - A row is two lines, name over path. One line made the name - the field a
 *   reader picks a row by - share a third of the overlay with a path that
 *   repeats its directory on every row
 * - `/` opens the filter rather than plain letters filtering as they are typed:
 *   the letter keys carry commands here (`r` launch, `t`/`i`/`s` tabs)
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from './doomOverlay.ts';
import {
  CURSOR_BLOCK,
  ELLIPSIS,
  fit,
  isControlInput,
  matchesQuery,
  pathTail,
  rightAligned,
  SELECTION_MARKER,
} from './overlayText';

export const WORKFLOW_CATALOG_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;

/** One workflow file, as the catalog tool reports it. */
export interface WorkflowCatalogRow {
  /** Stable identity and the loader's cache key: the absolute path. */
  key: string;
  name: string;
  relativePath: string;
  description: string;
  tags: readonly string[];
}

export interface WorkflowInputSummary {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
  options?: readonly string[];
}

export interface WorkflowJobSummary {
  name: string;
  runsOn?: string;
  steps: readonly string[];
}

/**
 * What the detail pane shows for one workflow. `runners` is undefined when the
 * workflow names no runner map at all, which is not the same as naming an empty
 * one - see `compatibleRunners`.
 */
export interface WorkflowCatalogDetail {
  triggers: readonly string[];
  inputs: readonly WorkflowInputSummary[];
  jobs: readonly WorkflowJobSummary[];
  runners?: readonly string[];
  /** Set when the file could not be parsed; the pane shows this instead of guessing. */
  error?: string;
}

export type WorkflowDetailLoader = (row: WorkflowCatalogRow) => WorkflowCatalogDetail;

/** Starts one workflow and returns immediately; the overlay closes on launch. */
export type WorkflowLaunchDispatcher = (row: WorkflowCatalogRow) => void;

export interface WorkflowCatalogOptions {
  loadDetail: WorkflowDetailLoader;
  /** Absent until a composition root wires the launch key to a real launcher. */
  launchWorkflow?: WorkflowLaunchDispatcher;
}

export type WorkflowDetailTab = 'triggers' | 'inputs' | 'steps';

type ThemeColor = Parameters<Theme['fg']>[0];

const TITLE = 'WORKFLOWS';
const BREADCRUMB = 'SPC › w / workflows › l / list';
const DIVIDER = '│';
const DEFAULT_PAGE_SIZE = 1;
const ROWS_PER_ENTRY = 2;
/** Indent under `${SELECTION_MARKER} `, so the path line hangs under the name. */
const META_INDENT = '  ';
const EMPTY_NAME = '(unnamed)';
const LAUNCH_KEY = 'r';
const FILTER_KEY = '/';
const KEY_CLEAR = '\x15';
const FILTER_LABEL = 'FILTER';
const EMPTY_MESSAGE = 'No workflow definitions were found in this repository.';
const TAB_ORDER: readonly WorkflowDetailTab[] = ['triggers', 'inputs', 'steps'];
const TAB_KEYS: Record<string, WorkflowDetailTab> = { t: 'triggers', i: 'inputs', s: 'steps' };
const FOOTER = '↑↓ cursor · JK scroll · tab detail · / filter · r launch · esc close';
const FOOTER_HINTS: readonly (readonly [string, string])[] = [
  ['↑↓', 'move'],
  ['JK', 'scroll'],
  ['tab', 'cycle'],
  ['/', 'filter'],
  ['r', 'launch'],
];
const FILTER_FOOTER = 'enter keep · esc clear · ctrl+u wipe';
const FILTER_FOOTER_HINTS: readonly (readonly [string, string])[] = [
  ['enter', 'keep'],
  ['esc', 'clear'],
  ['ctrl+u', 'wipe'],
];

interface SplitLayout {
  leftContentWidth: number;
  rightContentWidth: number;
  gutterWidth: number;
}

function splitLayout(width: number): SplitLayout {
  const paneBudget = Math.max(2, width - visibleWidth(DIVIDER));
  const leftPaneWidth = Math.max(1, Math.floor(paneBudget / 3));
  const rightPaneWidth = Math.max(1, paneBudget - leftPaneWidth);
  const gutterWidth = leftPaneWidth >= 3 && rightPaneWidth >= 3 ? 1 : 0;
  return {
    leftContentWidth: Math.max(1, leftPaneWidth - gutterWidth),
    rightContentWidth: Math.max(1, rightPaneWidth - gutterWidth),
    gutterWidth,
  };
}

function appendWrapped(lines: string[], text: string, width: number, colour: ThemeColor, theme: Theme): void {
  for (const line of wrapTextWithAnsi(text, Math.max(1, width))) lines.push(theme.fg(colour, line));
}

function appendSection(lines: string[], heading: string, items: readonly string[], width: number, theme: Theme): void {
  lines.push(theme.bold(theme.fg('accent', heading)));
  if (items.length === 0) lines.push(theme.fg('dim', '  none'));
  else for (const item of items) appendWrapped(lines, `  • ${item}`, width, 'text', theme);
  lines.push('');
}

function inputLabel(input: WorkflowInputSummary): string {
  const qualifiers = [
    input.required ? 'required' : 'optional',
    input.default === undefined ? undefined : `default ${input.default}`,
    input.options && input.options.length > 0 ? `one of ${input.options.join(', ')}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const description = input.description ? `${input.description} · ` : '';
  return `${input.name} — ${description}${qualifiers.join(' · ')}`;
}

export function workflowDetailLines(
  detail: WorkflowCatalogDetail,
  tab: WorkflowDetailTab,
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  if (detail.error) {
    lines.push(theme.bold(theme.fg('error', 'WORKFLOW ERROR')));
    appendWrapped(lines, detail.error, width, 'error', theme);
    lines.push('');
    return lines;
  }
  if (tab === 'triggers') {
    appendSection(lines, 'TRIGGERS', detail.triggers, width, theme);
    // No runner map means every runner qualifies, which a bare "none" would
    // report as the opposite.
    appendSection(lines, 'RUNNERS', detail.runners ?? ['any available runner'], width, theme);
    return lines;
  }
  if (tab === 'inputs') {
    appendSection(lines, 'DISPATCH INPUTS', detail.inputs.map(inputLabel), width, theme);
    return lines;
  }
  for (const job of detail.jobs) {
    lines.push(theme.bold(theme.fg('accent', job.name)));
    if (job.runsOn) lines.push(theme.fg('dim', `  runs-on ${job.runsOn}`));
    if (job.steps.length === 0) lines.push(theme.fg('dim', '  no steps'));
    else for (const step of job.steps) appendWrapped(lines, `  • ${step}`, width, 'text', theme);
    lines.push('');
  }
  if (detail.jobs.length === 0) appendSection(lines, 'JOBS', [], width, theme);
  return lines;
}

function tabStrip(tab: WorkflowDetailTab, width: number, theme: Theme): string {
  const labels = TAB_ORDER.map((candidate) => {
    const label = candidate.toUpperCase();
    return candidate === tab ? theme.inverse(theme.bold(` ${label} `)) : theme.fg('dim', ` ${label} `);
  }).join(' ');
  return truncateToWidth(labels, Math.max(0, width), ELLIPSIS);
}

export function filterWorkflowRows(rows: readonly WorkflowCatalogRow[], query: string): readonly WorkflowCatalogRow[] {
  if (!query.trim()) return rows;
  return rows.filter((row) =>
    matchesQuery([row.name, row.relativePath, row.description, row.tags.join(' ')].join(' '), query),
  );
}

export class WorkflowCatalogComponent extends DoomOverlay {
  private readonly rows: readonly WorkflowCatalogRow[];
  private readonly detailCache = new Map<string, WorkflowCatalogDetail>();
  private cursorIndex = 0;
  private tab: WorkflowDetailTab = 'triggers';
  private query = '';
  private filtering = false;
  private notice: string | undefined;
  private listPageSize = DEFAULT_PAGE_SIZE;
  private detailPageSize = DEFAULT_PAGE_SIZE;
  private detailOffset = 0;
  private detailTotal = 0;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    rows: readonly WorkflowCatalogRow[],
    private readonly done: (result: undefined) => void,
    private readonly options: WorkflowCatalogOptions,
  ) {
    super(tui, theme);
    this.rows = [...rows].sort((left, right) => left.name.localeCompare(right.name));
  }

  private matches(): readonly WorkflowCatalogRow[] {
    return filterWorkflowRows(this.rows, this.query);
  }

  private cursorRow(): WorkflowCatalogRow | undefined {
    const matches = this.matches();
    return matches[Math.min(this.cursorIndex, Math.max(0, matches.length - 1))];
  }

  /** Parsed once per workflow, then reused for every repaint of that row. */
  private detailFor(row: WorkflowCatalogRow): WorkflowCatalogDetail {
    const cached = this.detailCache.get(row.key);
    if (cached) return cached;
    const detail = this.options.loadDetail(row);
    this.detailCache.set(row.key, detail);
    return detail;
  }

  private moveCursor(delta: number): void {
    const count = this.matches().length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, this.cursorIndex + delta));
    if (next === this.cursorIndex) return;
    this.cursorIndex = next;
    // The detail pane follows the cursor, so its scroll belonged to the row
    // that was showing, not the one replacing it.
    this.detailOffset = 0;
    this.invalidate();
  }

  private switchTab(tab: WorkflowDetailTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.detailOffset = 0;
    this.invalidate();
  }

  private cycleTab(): void {
    const current = TAB_ORDER.indexOf(this.tab);
    this.switchTab(TAB_ORDER[(current + 1) % TAB_ORDER.length] ?? 'triggers');
  }

  private scrollDetail(delta: number): void {
    if (!this.cursorRow()) return;
    const maximum = Math.max(0, this.detailTotal - this.detailPageSize);
    const next = Math.max(0, Math.min(maximum, this.detailOffset + delta));
    if (next === this.detailOffset) return;
    this.detailOffset = next;
    this.invalidate();
  }

  private setNotice(notice: string): void {
    this.notice = notice;
    this.invalidate();
  }

  private setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    // The previous index named a row this filter may no longer list.
    this.cursorIndex = 0;
    this.detailOffset = 0;
    this.invalidate();
  }

  private launchCursor(): void {
    const row = this.cursorRow();
    if (!row) {
      this.setNotice('launch unavailable · no workflow is selected');
      return;
    }
    const launchWorkflow = this.options.launchWorkflow;
    if (!launchWorkflow) {
      this.setNotice('launch unavailable · no workflow launcher is attached');
      return;
    }
    const detail = this.detailFor(row);
    if (detail.error) {
      this.setNotice(`launch unavailable · ${detail.error}`);
      return;
    }
    // Closing first is what makes the launcher's own prompts reachable: they
    // are host dialogs, and a fullscreen overlay sits over them.
    this.done(undefined);
    launchWorkflow(row);
  }

  private handleFilterInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.filtering = false;
      this.setQuery('');
      this.invalidate();
      return;
    }
    if (matchesKey(data, 'enter')) {
      this.filtering = false;
      this.invalidate();
      return;
    }
    if (matchesKey(data, 'backspace')) {
      this.setQuery(this.query.slice(0, -1));
      return;
    }
    if (data === KEY_CLEAR) {
      this.setQuery('');
      return;
    }
    if (!isControlInput(data)) this.setQuery(this.query + data);
  }

  handleInput(data: string): void {
    if (this.filtering) {
      this.handleFilterInput(data);
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.shift('k'))) return this.scrollDetail(-1);
    if (matchesKey(data, Key.shift('j'))) return this.scrollDetail(1);
    if (matchesKey(data, 'up') || data === 'k') return this.moveCursor(-1);
    if (matchesKey(data, 'down') || data === 'j') return this.moveCursor(1);
    if (matchesKey(data, 'pageUp')) return this.moveCursor(-this.listPageSize);
    if (matchesKey(data, 'pageDown')) return this.moveCursor(this.listPageSize);
    if (matchesKey(data, 'tab')) return this.cycleTab();
    if (data === FILTER_KEY) {
      this.filtering = true;
      this.notice = undefined;
      this.invalidate();
      return;
    }
    if (data === LAUNCH_KEY) return this.launchCursor();
    const tab = TAB_KEYS[data];
    if (tab) this.switchTab(tab);
  }

  protected getChrome(): DoomOverlayChrome {
    const matches = this.matches();
    const scope = this.query ? `${matches.length} of ${this.rows.length}` : `${this.rows.length}`;
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: `${scope} workflows · ${this.tab}`,
      footer: this.filtering ? FILTER_FOOTER : FOOTER,
      footerHints: this.filtering ? FILTER_FOOTER_HINTS : FOOTER_HINTS,
      footerRight: matches.length
        ? `${Math.min(this.cursorIndex, matches.length - 1) + 1}/${matches.length}`
        : 'no match',
    };
  }

  protected renderBody(width: number, height: number): string[] {
    const filterRows = this.filtering || this.query ? 1 : 0;
    const transientRows = filterRows + (this.notice === undefined ? 0 : 1);
    const mainHeight = Math.max(0, height - transientRows);
    const layout = splitLayout(width);
    const left = this.renderList(layout.leftContentWidth, mainHeight);
    const right = this.renderDetail(layout.rightContentWidth, mainHeight);
    const gutter = ' '.repeat(layout.gutterWidth);
    const divider = this.theme.fg('borderMuted', DIVIDER);
    const lines: string[] = [];
    for (let index = 0; index < mainHeight; index++) {
      lines.push(
        `${fit(left[index] ?? '', layout.leftContentWidth)}${gutter}${divider}${gutter}${fit(
          right[index] ?? '',
          layout.rightContentWidth,
        )}`,
      );
    }
    if (filterRows) {
      const value = this.filtering ? `${this.query}${CURSOR_BLOCK}` : this.query;
      lines.push(` ${this.theme.bold(this.theme.fg('accent', FILTER_LABEL))} ${value}`);
    }
    if (this.notice !== undefined) lines.push(` ${this.theme.fg('muted', this.notice)}`);
    return lines.slice(0, height).map((line) => fit(line, width));
  }

  private renderList(width: number, height: number): string[] {
    const matches = this.matches();
    const lines = [this.theme.bold(this.theme.fg('accent', `WORKFLOWS ${matches.length}`))];
    if (matches.length === 0) {
      appendWrapped(
        lines,
        this.rows.length === 0 ? EMPTY_MESSAGE : 'No workflow matches this filter.',
        width,
        'dim',
        this.theme,
      );
      this.listPageSize = DEFAULT_PAGE_SIZE;
      return lines.slice(0, height);
    }

    this.listPageSize = Math.max(DEFAULT_PAGE_SIZE, Math.floor((height - 1) / ROWS_PER_ENTRY));
    const active = Math.min(this.cursorIndex, matches.length - 1);
    const start = Math.max(
      0,
      Math.min(active - this.listPageSize + 1, Math.max(0, matches.length - this.listPageSize)),
    );
    for (const [offset, row] of matches.slice(start, start + this.listPageSize).entries()) {
      const current = start + offset === active;
      const marker = current ? this.theme.fg('accent', SELECTION_MARKER) : ' ';
      const label = row.name || EMPTY_NAME;
      const name = current ? this.theme.bold(this.theme.fg('accent', label)) : this.theme.fg('text', label);
      const meta = this.theme.fg('dim', pathTail(row.relativePath, Math.max(0, width - META_INDENT.length)));
      lines.push(fit(`${marker} ${name}`, width));
      lines.push(fit(`${META_INDENT}${meta}`, width));
    }
    return lines.slice(0, height);
  }

  private renderDetail(width: number, height: number): string[] {
    const row = this.cursorRow();
    if (!row) {
      this.detailTotal = 0;
      this.detailPageSize = Math.max(DEFAULT_PAGE_SIZE, height);
      this.detailOffset = 0;
      const lines = [this.theme.bold(this.theme.fg('accent', 'WORKFLOW DETAIL')), ''];
      appendWrapped(
        lines,
        this.rows.length === 0 ? EMPTY_MESSAGE : 'No workflow matches this filter.',
        width,
        'text',
        this.theme,
      );
      return lines.slice(0, height);
    }

    const header = [
      rightAligned(
        this.theme.bold(this.theme.fg('accent', `INSPECTING ${row.name || EMPTY_NAME}`)),
        this.theme.fg('dim', pathTail(row.relativePath, Math.max(0, Math.floor(width / 2)))),
        width,
      ),
    ];
    if (row.description) appendWrapped(header, row.description, width, 'text', this.theme);
    if (row.tags.length > 0) appendWrapped(header, row.tags.join(' · '), width, 'dim', this.theme);
    header.push(tabStrip(this.tab, width, this.theme), '');

    const body = workflowDetailLines(this.detailFor(row), this.tab, width, this.theme);
    this.detailPageSize = Math.max(0, height - header.length);
    this.detailTotal = body.length;
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, body.length - this.detailPageSize));
    return [...header, ...body.slice(this.detailOffset, this.detailOffset + this.detailPageSize)].slice(0, height);
  }
}

export async function openWorkflowCatalogOverlay(
  ctx: ExtensionContext,
  rows: readonly WorkflowCatalogRow[],
  options: WorkflowCatalogOptions,
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new WorkflowCatalogComponent(tui, theme, rows, done, options),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
