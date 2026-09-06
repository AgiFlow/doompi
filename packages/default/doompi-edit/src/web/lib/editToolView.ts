import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';

/** Pi emits `+12 text`, `-12 text`, ` 12 text`, and a blank-numbered ` ... ` elision between hunks. */
const DIFF_ROW_PATTERN = /^([+\- ])( *\d*) (.*)$/u;
const CONTEXT_MARKER = ' ';

export type DiffMarker = '+' | '-' | typeof CONTEXT_MARKER;

export interface DiffRow {
  readonly marker: DiffMarker;
  readonly lineNumber: string;
  readonly content: string;
}

export interface EditCallView {
  readonly path: string;
  /** `N range` or `N ranges`, the count the TUI's call heading shows. */
  readonly ranges: string;
}

export interface EditResultView {
  readonly rows: readonly DiffRow[];
  /** Widest line number among the rows, in characters, sizing the gutter. */
  readonly gutter: number;
}

/** What the edit call heading shows: the path and how many ranges the call touches. */
export function editCallView(args: Readonly<Record<string, unknown>>): EditCallView {
  const count = Array.isArray(args.edits) ? args.edits.length : 0;
  return {
    path: typeof args.path === 'string' ? args.path : '',
    ranges: `${count} ${count === 1 ? 'range' : 'ranges'}`,
  };
}

function toDiffMarker(value: string | undefined): DiffMarker {
  return value === '+' || value === '-' ? value : CONTEXT_MARKER;
}

/** Pi's display diff as rows; a line that is not a diff row reads as unnumbered context. */
export function parseDiffRows(diff: string): DiffRow[] {
  return diff.split('\n').map((line) => {
    const expanded = line.replaceAll('\t', '  ');
    const match = DIFF_ROW_PATTERN.exec(expanded);
    if (!match) return { marker: CONTEXT_MARKER, lineNumber: '', content: expanded };
    return { marker: toDiffMarker(match[1]), lineNumber: (match[2] ?? '').trim(), content: match[3] ?? '' };
  });
}

/** The diff a successful edit carries in its details; undefined when the details never arrived. */
export function editResultView(result: ToolResultView | null): EditResultView | undefined {
  const details = result?.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const diff = (details as { diff?: unknown }).diff;
  if (typeof diff !== 'string' || diff.length === 0) return undefined;
  const rows = parseDiffRows(diff);
  return { rows, gutter: rows.reduce((widest, row) => Math.max(widest, row.lineNumber.length), 1) };
}

/** The result's text lines, for the error case where the diff never happened. */
export function resultTextLines(result: ToolResultView | null, output: string): string[] {
  const text =
    result === null
      ? output
      : result.content
          .flatMap((block) => {
            const record =
              typeof block === 'object' && block !== null ? (block as { type?: unknown; text?: unknown }) : {};
            return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
          })
          .join('\n');
  const lines = text.replaceAll('\t', '  ').replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  return lines;
}
