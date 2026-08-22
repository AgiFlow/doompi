/**
 * Turns a cmux render grid into ANSI text lines for the run panel.
 *
 * WHY THIS EXISTS:
 * `cmux read-screen` and its `capture-pane` alias return plain text by design -
 * their own help says so, and neither takes an escape-sequence flag - so a run
 * hosted in cmux reached the panel with every colour stripped at capture time.
 * `cmux rpc terminal.replay` answers with a `cmux.render-grid.v1` instead: a
 * flat list of spans carrying text, a row, a column, and a style id, plus the
 * style table those ids index. Rebuilding the lines from it is the only way to
 * show a cmux run in the colours it actually printed.
 *
 * DESIGN PATTERNS:
 * - A style whose source is `default` emits NO colour. That is the child
 *   terminal's own default, and painting it would replace the panel's theme
 *   with the child's background on every cell
 * - Every styled span closes with a reset. A span that ended a line without one
 *   would bleed its colour through the panel's frame and into the rows beneath
 * - Pure and synchronous, so the mapping is assertable without cmux or a
 *   terminal. Fetching the grid belongs to the adapter that owns `pi.exec`
 */

import { visibleWidth } from '@earendil-works/pi-tui';

import type { RenderGrid, RenderGridSpan, RenderGridStyle } from '../../schemas/workflowPi.ts';

const RESET = '\x1b[0m';
const DEFAULT_SOURCE = 'default';
const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;
const HEX_RADIX = 16;
const RED_START = 0;
const GREEN_START = 2;
const BLUE_START = 4;
const PAIR = 2;
const SGR_BOLD = '1';
const SGR_FAINT = '2';
const SGR_ITALIC = '3';
const SGR_UNDERLINE = '4';
const SGR_INVERSE = '7';
const SGR_STRIKETHROUGH = '9';

function channels(hex: string): [number, number, number] | undefined {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) return undefined;
  const value = match[1] as string;
  return [
    Number.parseInt(value.slice(RED_START, RED_START + PAIR), HEX_RADIX),
    Number.parseInt(value.slice(GREEN_START, GREEN_START + PAIR), HEX_RADIX),
    Number.parseInt(value.slice(BLUE_START, BLUE_START + PAIR), HEX_RADIX),
  ];
}

/**
 * The SGR prefix for one style, or an empty string when the style is the
 * terminal's plain default. Palette colours arrive already resolved to hex, so
 * one truecolour path covers both palette and rgb sources.
 */
export function styleSequence(style: RenderGridStyle | undefined): string {
  if (!style) return '';
  const codes: string[] = [];
  if (style.bold) codes.push(SGR_BOLD);
  if (style.faint) codes.push(SGR_FAINT);
  if (style.italic) codes.push(SGR_ITALIC);
  if (style.underline) codes.push(SGR_UNDERLINE);
  if (style.inverse) codes.push(SGR_INVERSE);
  if (style.strikethrough) codes.push(SGR_STRIKETHROUGH);
  const foreground = style.foreground_source !== DEFAULT_SOURCE ? channels(style.foreground ?? '') : undefined;
  if (foreground) codes.push(`38;2;${foreground.join(';')}`);
  const background = style.background_source !== DEFAULT_SOURCE ? channels(style.background ?? '') : undefined;
  if (background) codes.push(`48;2;${background.join(';')}`);
  return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`;
}

/** Spans of one row, laid back out at their columns with the gaps filled. */
function rowLine(spans: readonly RenderGridSpan[], styles: Map<number, RenderGridStyle>): string {
  const ordered = [...spans].sort((left, right) => left.column - right.column);
  let line = '';
  let column = 0;
  for (const span of ordered) {
    if (span.column > column) line += ' '.repeat(span.column - column);
    const sequence = styleSequence(span.style_id === undefined ? undefined : styles.get(span.style_id));
    line += sequence ? `${sequence}${span.text}${RESET}` : span.text;
    // The grid measures a span in display columns, which is what a wide glyph
    // costs the next span's placement; its length in code units is not.
    column = Math.max(column, span.column) + (span.cell_width ?? visibleWidth(span.text));
  }
  return line.trimEnd();
}

function linesFrom(spans: readonly RenderGridSpan[], styles: Map<number, RenderGridStyle>): string[] {
  const rows = new Map<number, RenderGridSpan[]>();
  for (const span of spans) {
    const existing = rows.get(span.row);
    if (existing) existing.push(span);
    else rows.set(span.row, [span]);
  }
  const ordered = [...rows.keys()].sort((left, right) => left - right);
  const last = ordered.at(-1);
  if (last === undefined) return [];
  // Rows with no span at all are blank lines in the child's screen, not gaps to
  // close up: dropping them would rewrap the output the user is reading.
  const first = ordered[0] as number;
  const result: string[] = [];
  for (let row = first; row <= last; row++) result.push(rowLine(rows.get(row) ?? [], styles));
  return result;
}

/**
 * The grid's scrollback and viewport as one list of lines, oldest first,
 * trimmed to the last `limit` lines the panel can show. The two span sets live
 * in separate row spaces, so they are laid out separately and then joined.
 */
export function renderGridLines(grid: RenderGrid, limit: number): string[] {
  const styles = new Map((grid.styles ?? []).map((style) => [style.id, style]));
  const lines = [...linesFrom(grid.scrollback_spans ?? [], styles), ...linesFrom(grid.row_spans ?? [], styles)];
  while (lines.length > 0 && !(lines.at(-1) ?? '').trim()) lines.pop();
  return limit > 0 ? lines.slice(-limit) : lines;
}
