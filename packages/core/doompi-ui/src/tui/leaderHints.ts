import type { ExtensionContext, ReadonlyFooterDataProvider, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

import type { Component } from '@earendil-works/pi-tui';
import type { LeaderSnapshot, UiMinorModeStatus } from '../services/state/uiState.ts';
import { alignLine, fitStyledLine, formatTokens, packSegments, padLine } from './rendering.ts';

/** The background palette is not exported by name, so take it from the method. */
type ThemeBg = Parameters<Theme['bg']>[0];

const WIDE_HINT_WIDTH = 100;
/**
 * No frame rows to pay for, so the whole budget is content. Two-line option
 * cards need roughly double the grid rows a single-line list did, plus a blank
 * row of breathing space at the top and bottom.
 *
 * Exported because tests assert the panel stays inside it; a second copy of the
 * number in the test file drifted from this one and stopped catching anything.
 */
export const MAX_WIDGET_LINES = 21;
/** Blank, header, blank above the grid, and the closing blank below it. */
const CHROME_LINES = 4;
/** Rule, MODES, SESSION, EXTENSIONS: what the root board's diagnostics want. */
const DIAGNOSTIC_RESERVE = 4;
/** Leading pad inside the shaded block, mirrored by padLine on the right. */
const PANEL_INSET = ' ';
const MIN_RENDER_WIDTH = 4;
const CONTENT_INSET = 4;
const GRID_GAP = 2;
const DIAGNOSTIC_LABEL_WIDTH = 11;
const DIAGNOSTIC_VALUE_INSET = 15;
const MAX_EXTENSION_LINES = 2;
const STATUS_SEPARATOR = '  ·  ';
const SEGMENT_GAP = '  ';
/**
 * Column count comes from width alone, never from the widest cell, so the root
 * board and every sub-board land on the same grid at the same terminal size.
 * Sizing to content made one long description narrow every other space's grid.
 */
const COLUMN_BREAKPOINTS: readonly { minWidth: number; columns: number }[] = [
  { minWidth: 130, columns: 4 },
  { minWidth: 90, columns: 3 },
  { minWidth: 56, columns: 2 },
];
const SINGLE_COLUMN = 1;
/** Marks the row that leaves an active minor mode; painted apart from the rest. */
const EXIT_TONE = 'exit';
/** Puts the description under the label rather than under the badge. */
const DETAIL_INDENT = '    ';
const HORIZONTAL_BORDER = '─';
const CONTINUATION_MARKER = '↳';
const DIM_COLOR: ThemeColor = 'dim';
const TEXT_COLOR: ThemeColor = 'text';
const MUTED_COLOR: ThemeColor = 'muted';
const ACCENT_COLOR: ThemeColor = 'accent';
const WARNING_COLOR: ThemeColor = 'warning';
const HEADING_COLOR: ThemeColor = 'mdHeading';
const BORDER_COLOR: ThemeColor = 'borderAccent';
const MUTED_BORDER_COLOR: ThemeColor = 'borderMuted';
/** Subtle panel shade; avoid the brighter active/selection surface used by messages. */
const PANEL_BACKGROUND: ThemeBg = 'toolPendingBg';
// The mockup colors each extension status differently so adjacent values stay
// separable at a glance; cycling this palette reproduces that without hardcoding
// a color per status key.
const STATUS_COLORS: ThemeColor[] = ['mdCode', 'toolDiffAdded', 'warning', 'muted'];

export class LeaderHints implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly snapshot: LeaderSnapshot,
    private readonly context?: ExtensionContext,
    private readonly footerData?: ReadonlyFooterDataProvider,
    private readonly modes: readonly UiMinorModeStatus[] = [],
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0 || !this.snapshot.active) return [];
    if (width < MIN_RENDER_WIDTH) return [this.theme.fg(BORDER_COLOR, HORIZONTAL_BORDER.repeat(width))];

    // A filled block rather than a framed one: the shade alone separates the
    // panel from the transcript, which buys back the two rows a frame costs.
    const contentWidth = Math.max(1, width - CONTENT_INSET);
    const shade = (content: string): string =>
      this.theme.bg(PANEL_BACKGROUND, padLine(`${PANEL_INSET}${content}`, width));
    const badge = this.theme.inverse(this.theme.bold(this.theme.fg(HEADING_COLOR, ' LEADER ')));
    const breadcrumb = `${this.snapshot.prefix.join(' › ')} / ${this.snapshot.label}`;
    const header = shade(
      alignLine(
        `${badge} ${this.theme.bold(this.theme.fg(TEXT_COLOR, breadcrumb))}`,
        this.theme.fg(DIM_COLOR, 'esc cancel · backspace up'),
        contentWidth,
      ),
    );
    const rootTrail = this.snapshot.rootOptions?.map((option) => `${option.key} ${option.label}`).join(' · ');
    const trail =
      width >= WIDE_HINT_WIDTH && this.snapshot.prefix.length > 1 && rootTrail
        ? [shade(this.theme.fg(DIM_COLOR, `root  ${rootTrail}`))]
        : [];
    // Options are the interactive surface, so they claim space before the
    // diagnostics do; truncating them would hide a reachable key.
    const optionBudget = Math.max(1, MAX_WIDGET_LINES - 2 - trail.length);
    const columns = COLUMN_BREAKPOINTS.find((breakpoint) => width >= breakpoint.minWidth)?.columns ?? SINGLE_COLUMN;
    // Two-line cards are the intended rhythm, but they are not worth the rows
    // they cost once they start pushing diagnostics off the bottom. Sub-boards
    // draw no diagnostics, so they reserve nothing and keep their descriptions.
    const reserve = this.snapshot.prefix.length === 1 ? DIAGNOSTIC_RESERVE : 0;
    const detailBudget = Math.max(1, MAX_WIDGET_LINES - CHROME_LINES - trail.length - reserve);
    const optionLines = this.renderOptionGrid(contentWidth, columns, detailBudget).slice(0, optionBudget).map(shade);
    // Four rows are spoken for before diagnostics get any: the blank, header and
    // blank above, and the closing blank below. Counting only two of them let
    // this budget overrun, and the final `slice` did the real cutting silently
    // from the end, which is how the EXTENSIONS row went missing when MODES
    // arrived. Take all four off here so what is dropped is decided in one place.
    const diagnosticsBudget = Math.max(0, MAX_WIDGET_LINES - 4 - trail.length - optionLines.length);
    // Session and extension diagnostics belong to the board opened directly by
    // SPC/^SPC. Sub-boards stay focused on their own actions and navigation.
    const diagnostics =
      this.snapshot.prefix.length === 1
        ? this.renderDiagnostics(contentWidth).slice(0, diagnosticsBudget).map(shade)
        : [];
    // Blank shaded rows top and bottom: the panel butts against the editor above
    // and the modeline below, so the shade needs room before its first glyph.
    const body = [shade(''), header, shade(''), ...optionLines, ...trail, ...diagnostics];

    return [...body.slice(0, MAX_WIDGET_LINES - 1), shade('')];
  }

  /**
   * Lays options out on a fixed cell grid rather than a packed run of segments,
   * so keys and labels stay column-aligned when the list wraps.
   *
   * `budget` is the rows the grid may take while still leaving the panel its
   * chrome and diagnostics. It decides whether descriptions are drawn, not
   * whether options are kept: a grid that overruns is cut from the end by the
   * caller, which would take whole options away with it.
   */
  private renderOptionGrid(width: number, columns: number, budget: number): string[] {
    if (this.snapshot.options.length === 0) return [];

    // Equal cells, sized from the grid rather than from their contents, so a
    // long description is ellipsised instead of widening every other column.
    const cellWidth = Math.max(1, Math.floor((width - GRID_GAP * (columns - 1)) / columns));
    const withDetail = Math.ceil(this.snapshot.options.length / columns) * 2 <= budget;

    // Two lines per option, as the mockup lays them out: the key badge and a
    // bold label, then the description indented under the label.
    const cells = this.snapshot.options.map((option) => {
      const badge = this.theme.inverse(
        this.theme.bold(this.theme.fg(option.tone === EXIT_TONE ? WARNING_COLOR : ACCENT_COLOR, ` ${option.key} `)),
      );
      return {
        heading: `${badge} ${this.theme.bold(this.theme.fg(TEXT_COLOR, option.label))}`,
        detail: option.detail ? `${DETAIL_INDENT}${this.theme.fg(DIM_COLOR, option.detail)}` : '',
      };
    });

    const gap = ' '.repeat(GRID_GAP);
    const rows: string[] = [];
    for (let index = 0; index < cells.length; index += columns) {
      const group = cells.slice(index, index + columns);
      // fitStyledLine, not padLine: fixed cells clip descriptions routinely now,
      // and it is the one that ellipsises and drops the hard reset pi-tui injects,
      // which would otherwise cancel the panel shade partway along the row.
      rows.push(group.map((cell) => fitStyledLine(cell.heading, cellWidth)).join(gap));
      // Keep the second row even when every detail is empty. Each option card
      // then retains the same two-line rhythm instead of collapsing terse items
      // into a denser list than items with supporting text.
      if (withDetail) rows.push(group.map((cell) => fitStyledLine(cell.detail, cellWidth)).join(gap));
    }
    return rows;
  }

  /** Content lines only: the caller paints the shade and pads to full width. */
  private renderDiagnostics(width: number): string[] {
    const session = this.sessionDiagnostics();
    const extensions = this.extensionDiagnostics(width);
    const modes = this.modeDiagnostics();
    if (!session && !modes && extensions.length === 0) return [];

    const lines = [this.theme.fg(MUTED_BORDER_COLOR, HORIZONTAL_BORDER.repeat(width))];
    // Above SESSION because it is the more consequential fact: session counters
    // describe what this session has spent, a mode describes what it will do.
    //
    // No blank rows between these three. The diagnostics budget is what is left
    // after the option grid takes its share, which at a full grid is exactly one
    // row per label: a spacer here does not cost breathing room, it costs the
    // EXTENSIONS row entirely. Distinct labels in distinct colours separate them
    // well enough without one.
    if (modes) lines.push(this.diagnosticLine('MODES', modes, WARNING_COLOR));
    if (session) lines.push(this.diagnosticLine('SESSION', session, HEADING_COLOR));
    for (const [index, extension] of extensions.entries()) {
      const isFirst = index === 0;
      lines.push(
        this.diagnosticLine(
          isFirst ? 'EXTENSIONS' : CONTINUATION_MARKER,
          extension,
          isFirst ? ACCENT_COLOR : DIM_COLOR,
        ),
      );
    }
    return lines;
  }

  private diagnosticLine(label: string, value: string, color: ThemeColor): string {
    return `${this.theme.bold(this.theme.fg(color, label.padEnd(DIAGNOSTIC_LABEL_WIDTH)))}${value}`;
  }

  /**
   * The enabled modes with their detail, which is the long form of what the
   * editor's badge row shows as bare names.
   *
   * This panel is opened deliberately and has room, so it is the right place
   * for `plan (normal - read only)`: the badge row is glanced at mid-typing and
   * only has to answer which modes are on.
   */
  private modeDiagnostics(): string | undefined {
    if (this.modes.length === 0) return undefined;
    return this.modes
      .map((mode) => {
        const label = this.theme.fg(WARNING_COLOR, mode.label.toLowerCase());
        return mode.detail ? `${label}${this.theme.fg(DIM_COLOR, ` (${mode.detail})`)}` : label;
      })
      .join(this.theme.fg(DIM_COLOR, STATUS_SEPARATOR));
  }

  private sessionDiagnostics(): string | undefined {
    if (!this.context) return undefined;

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    for (const entry of this.context.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      input += entry.message.usage.input;
      output += entry.message.usage.output;
      cacheRead += entry.message.usage.cacheRead;
      cacheWrite += entry.message.usage.cacheWrite;
      cost += entry.message.usage.cost.total;
    }

    const cachedTotal = input + cacheRead + cacheWrite;
    const cacheHit = cachedTotal === 0 ? 0 : (cacheRead / cachedTotal) * 100;
    const usage = this.context.getContextUsage();
    const context =
      usage?.percent === null || usage?.percent === undefined
        ? 'ctx ?'
        : `ctx ${usage.percent.toFixed(1)}% / ${formatTokens(usage.contextWindow)}`;
    // Built as sibling segments rather than nested theme calls so each color
    // closes cleanly instead of resetting the one around it.
    const metrics = this.theme.fg(
      MUTED_COLOR,
      `↑${formatTokens(input)}  ↓${formatTokens(output)}  R${formatTokens(cacheRead)}  W${formatTokens(
        cacheWrite,
      )}  CH${cacheHit.toFixed(1)}%`,
    );
    const costText = this.theme.fg(WARNING_COLOR, `$${cost.toFixed(3)}`);
    return `${metrics}${SEGMENT_GAP}${costText}${this.theme.fg(DIM_COLOR, `${STATUS_SEPARATOR}${context}`)}`;
  }

  private extensionDiagnostics(width: number): string[] {
    if (!this.footerData) return [];

    const statuses = [...this.footerData.getExtensionStatuses().values()];
    const providers = this.footerData.getAvailableProviderCount();
    const values = [...statuses];
    if (providers > 0) values.push(`${providers} provider${providers === 1 ? '' : 's'}`);
    const colored = values.map((value, index) =>
      this.theme.fg(STATUS_COLORS[index % STATUS_COLORS.length] as ThemeColor, value),
    );
    const valueWidth = Math.max(1, width - DIAGNOSTIC_VALUE_INSET);
    return packSegments(colored, valueWidth, this.theme.fg(DIM_COLOR, STATUS_SEPARATOR)).slice(0, MAX_EXTENSION_LINES);
  }
}
