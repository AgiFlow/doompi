import { highlightCode, type Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { renderLineNumber } from './codeGutter.ts';
import { fitStyledLine } from './rendering.ts';

/** The background palette is not exported by name, so take it from the method. */
type ThemeBg = Parameters<Theme['bg']>[0];

/** Pi emits `+12 text`, `-12 text`, ` 12 text`, and a blank-numbered ` ... ` elision between hunks. */
const DIFF_ROW_PATTERN = /^([+\- ])( *\d*) (.*)$/u;
const TAB_REPLACEMENT = '  ';
const CONTEXT_MARKER = ' ';

type ChangedMarker = '+' | '-';
type DiffMarker = ChangedMarker | typeof CONTEXT_MARKER;

interface DiffRow {
  marker: DiffMarker;
  lineNumber: string;
  content: string;
}

/**
 * Doom Emacs carries a diff on the background and leaves the foreground to
 * syntax highlighting, the way Magit's `magit-diff-added`/`-removed` faces do.
 * The theme's success and error backgrounds are its green- and red-tinted
 * washes, so any theme yields a readable added/removed pair.
 */
const ROW_BACKGROUND: Readonly<Record<ChangedMarker, ThemeBg>> = {
  '+': 'toolSuccessBg',
  '-': 'toolErrorBg',
};

const MARKER_COLOR: Readonly<Record<ChangedMarker, ThemeColor>> = {
  '+': 'toolDiffAdded',
  '-': 'toolDiffRemoved',
};

type Highlighter = (code: string, language?: string) => string[];

function isChangedMarker(marker: DiffMarker): marker is ChangedMarker {
  return marker !== CONTEXT_MARKER;
}

function toDiffMarker(value: string): DiffMarker {
  return value === '+' || value === '-' ? value : CONTEXT_MARKER;
}

function parseDiffRows(diff: string): DiffRow[] {
  return diff.split('\n').map((line) => {
    const expanded = line.replaceAll('\t', TAB_REPLACEMENT);
    const match = DIFF_ROW_PATTERN.exec(expanded);
    if (!match) return { marker: CONTEXT_MARKER, lineNumber: '', content: expanded };
    return { marker: toDiffMarker(match[1]!), lineNumber: match[2]!.trim(), content: match[3]! };
  });
}

/**
 * Highlight the diff as one block so multi-line constructs keep their context.
 * Interleaved removals make the block imperfect source, which the highlighter
 * tolerates; a line count mismatch falls back to flat diff coloring.
 */
function decorateRows(
  rows: readonly DiffRow[],
  language: string | undefined,
  theme: Theme,
  highlight: Highlighter,
): string[] {
  if (language !== undefined) {
    const highlighted = highlight(rows.map((row) => row.content).join('\n'), language);
    if (highlighted.length === rows.length) return highlighted;
  }
  return rows.map((row) => theme.fg(isChangedMarker(row.marker) ? 'toolOutput' : 'toolDiffContext', row.content));
}

/** A width-aware diff whose added and removed rows carry a full-width color band. */
class DoomDiff implements Component {
  private readonly gutter: number;

  constructor(
    private readonly rows: readonly DiffRow[],
    private readonly contents: readonly string[],
    private readonly theme: Theme,
  ) {
    // Pi already pads its numbers, so the widest one sizes the column.
    this.gutter = rows.reduce((widest, row) => Math.max(widest, row.lineNumber.length), 1);
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    return this.rows.map((row, index) => this.renderRow(row, this.contents[index] ?? row.content, width));
  }

  invalidate(): void {
    // Rows are immutable; only the color band width follows the terminal.
  }

  private renderRow({ marker, lineNumber }: DiffRow, content: string, width: number): string {
    const number = renderLineNumber(lineNumber, this.gutter, this.theme, isChangedMarker(marker));
    if (!isChangedMarker(marker)) return fitStyledLine(`${number} ${CONTEXT_MARKER}${content}`, width);

    const band = fitStyledLine(`${number} ${this.theme.fg(MARKER_COLOR[marker], marker)}${content}`, width);
    return this.theme.bg(ROW_BACKGROUND[marker], band);
  }
}

/** Render Pi's display diff with Doom's background-banded added and removed rows. */
export function renderDoomDiff(
  diff: string,
  theme: Theme,
  language: string | undefined,
  highlight: Highlighter = highlightCode,
): Component {
  const rows = parseDiffRows(diff);
  return new DoomDiff(rows, decorateRows(rows, language, theme, highlight), theme);
}
