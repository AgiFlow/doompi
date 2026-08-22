/**
 * Scrollable, filterable list picker for every long list this extension shows.
 *
 * Replaces a bare `ui.select`, which wrapped each `name · detail` pair across
 * two or three terminal rows and left no way to reach a row other than scrolling
 * past all of them. This is a doom overlay instead: one row per item, a windowed
 * list that scrolls with the selection, and a filter field that narrows as you
 * type.
 *
 * Generic over the value it hands back. `SPC w c` picks a failed run to recover
 * through it; browsing and launching workflows moved to `workflowCatalog.ts`,
 * which needs the detail on screen beside the list rather than behind a pick.
 *
 * Rendering is pure, so the surface can be asserted as text without a terminal.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from './doomOverlay.ts';
import { CURSOR_BLOCK, fit, isControlInput, matchesQuery, pathTail, SELECTION_MARKER } from './overlayText';

export const WORKFLOW_PICKER_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;

const FILTER_LABEL = 'FILTER';
const EMPTY_NAME = '(unnamed)';
const KEY_CLEAR = '\x15';
/** Rows the filter field and its trailing spacer take from the body. */
const FILTER_ROWS = 3;
/** Columns the marker and its trailing space take from a row. */
const MARKER_COLUMNS = 2;
/** Blank columns between the name column and the detail column. */
const COLUMN_GAP = 2;
const MIN_NAME_WIDTH = 16;
const NAME_RATIO = 0.45;

/** Neither palette name is exported, so take both from the theme's methods. */
type ThemeBg = Parameters<Theme['bg']>[0];
type ThemeColor = Parameters<Theme['fg']>[0];

const DIM: ThemeColor = 'dim';
const ACCENT: ThemeColor = 'accent';
const SELECTED_BG: ThemeBg = 'selectedBg';
const ROW_BG: ThemeBg = 'userMessageBg';

export interface PickerRow<T> {
  /** Stable identity, used only to keep rows distinct. */
  key: string;
  /** Left column. */
  name: string;
  /** Right column, trimmed from the front so its tail survives. */
  detail: string;
  /** Extra text the filter should match but the row does not show. */
  search?: string;
  value: T;
}

export interface WorkflowPickerConfig {
  title: string;
  breadcrumb: string;
  /** Plural noun for the header count, e.g. `workflows`. */
  unit: string;
  /** Verb on the enter key cap, e.g. `launch`. */
  action: string;
  filterPlaceholder: string;
  /** Shown when the source list itself is empty, as opposed to over-filtered. */
  emptyMessage: string;
}

export function filterPickerRows<T>(rows: readonly PickerRow<T>[], query: string): PickerRow<T>[] {
  if (!query.trim()) return [...rows];
  return rows.filter((row) => matchesQuery([row.name, row.detail, row.search ?? ''].join(' '), query));
}

export class WorkflowPickerComponent<T> extends DoomOverlay {
  private query = '';
  private selected = 0;
  private bodyHeight = 1;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly config: WorkflowPickerConfig,
    private readonly rows: readonly PickerRow<T>[],
    private readonly done: (value: T | undefined) => void,
  ) {
    super(tui, theme);
  }

  private matches(): PickerRow<T>[] {
    return filterPickerRows(this.rows, this.query);
  }

  /** Rows the list can draw, once the filter field has taken its share. */
  private capacity(): number {
    return Math.max(1, this.bodyHeight - FILTER_ROWS);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done(undefined);
      return;
    }
    const matches = this.matches();
    if (matchesKey(data, 'enter')) {
      const row = matches[Math.min(this.selected, matches.length - 1)];
      if (row) this.done(row.value);
      return;
    }

    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.move(-1, matches.length);
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.move(1, matches.length);
    else if (matchesKey(data, 'pageUp')) this.move(-this.capacity(), matches.length);
    else if (matchesKey(data, 'pageDown')) this.move(this.capacity(), matches.length);
    else if (matchesKey(data, 'backspace')) this.setQuery(this.query.slice(0, -1));
    else if (data === KEY_CLEAR) this.setQuery('');
    else if (!isControlInput(data)) this.setQuery(this.query + data);
    else return;

    this.tui.requestRender();
  }

  /** Editing the filter resets the cursor: the previous index named another row. */
  private setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    this.selected = 0;
  }

  private move(delta: number, count: number): void {
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
  }

  protected getChrome(): DoomOverlayChrome {
    const matches = this.matches();
    const scope = this.query ? `${matches.length} of ${this.rows.length}` : `${this.rows.length}`;
    return {
      title: this.config.title,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: this.config.breadcrumb,
      headerRight: `${scope} ${this.config.unit}`,
      footer: `↑↓ select · enter ${this.config.action} · type to filter · ctrl+u clear · esc cancel`,
      footerHints: [
        ['↑↓', 'select'],
        ['enter', this.config.action],
        ['type', 'filter'],
        ['ctrl+u', 'clear'],
        ['esc', 'cancel'],
      ],
      footerRight:
        matches.length > 0 ? `${Math.min(this.selected, matches.length - 1) + 1}/${matches.length}` : 'no match',
    };
  }

  protected renderBody(width: number, height: number): string[] {
    this.bodyHeight = height;
    return [...this.filterField(width), ...this.listLines(width)].slice(0, height);
  }

  private filterField(width: number): string[] {
    const value = this.query
      ? `${this.query}${CURSOR_BLOCK}`
      : `${CURSOR_BLOCK}${this.theme.fg(DIM, this.config.filterPlaceholder)}`;
    return [this.theme.fg(DIM, FILTER_LABEL), this.theme.bg(SELECTED_BG, fit(` ${value}`, width)), ''];
  }

  private listLines(width: number): string[] {
    if (this.rows.length === 0) return [this.theme.fg(DIM, this.config.emptyMessage)];
    const matches = this.matches();
    if (matches.length === 0) return [this.theme.fg(DIM, `No ${this.config.unit} match "${this.query}".`)];

    const capacity = this.capacity();
    const active = Math.min(this.selected, matches.length - 1);
    // The window follows the cursor rather than the other way round, so a filter
    // that shrinks the list can never strand the selection off-screen.
    const start = Math.max(0, Math.min(active - capacity + 1, Math.max(0, matches.length - capacity)));

    const nameWidth = Math.max(MIN_NAME_WIDTH, Math.floor((width - MARKER_COLUMNS - COLUMN_GAP) * NAME_RATIO));
    const detailWidth = Math.max(0, width - MARKER_COLUMNS - COLUMN_GAP - nameWidth);
    return matches.slice(start, start + capacity).map((row, offset) => {
      const current = start + offset === active;
      const marker = current ? this.theme.fg(ACCENT, SELECTION_MARKER) : ' ';
      const name = row.name || EMPTY_NAME;
      const label = current ? this.theme.bold(fit(name, nameWidth)) : fit(name, nameWidth);
      const detail = this.theme.fg(DIM, fit(pathTail(row.detail, detailWidth), detailWidth));
      const background: ThemeBg = current ? SELECTED_BG : ROW_BG;
      return this.theme.bg(background, fit(`${marker} ${label}${' '.repeat(COLUMN_GAP)}${detail}`, width));
    });
  }
}

export async function openWorkflowPickerOverlay<T>(
  ctx: ExtensionContext,
  config: WorkflowPickerConfig,
  rows: readonly PickerRow<T>[],
): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>(
    (tui, theme, _keybindings, done) => new WorkflowPickerComponent(tui, theme, config, rows, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
