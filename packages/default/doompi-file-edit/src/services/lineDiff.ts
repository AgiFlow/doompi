import type { FileEditsDiffHunk, FileEditsDiffRow } from '../types/fileEditsApi.ts';

/**
 * The line difference between two versions of a file, as bounded hunks.
 *
 * This is deliberately the package's own rather than Pi's `generateDiffString`:
 * that helper reaches the session process through an optional peer dependency,
 * and these routes run in a host that imports only the built entry, so its
 * presence is an assumption rather than a fact. A line diff is small enough to
 * own outright, and owning it means the wire carries structured rows instead of
 * a formatted string the browser has to parse back apart.
 *
 * Bounded twice over. Common prefix and suffix are trimmed first, which is what
 * makes a one-line change in a large file cheap. What remains is matched with a
 * longest-common-subsequence table, and only while that table stays under
 * MAX_MATRIX_CELLS: past it the changed region is reported as one replacement
 * rather than growing a matrix that would outweigh the file.
 */

/** Lines of unchanged context kept either side of a change. */
const CONTEXT_LINES = 3;

/** The largest LCS table worth building; past it the changed region is one replacement. */
const MAX_MATRIX_CELLS = 1_000_000;

export interface LineDiffResult {
  hunks: FileEditsDiffHunk[];
  additions: number;
  removals: number;
  /** True when the changed region was too large to match line by line. */
  approximate: boolean;
}

/** One step of the match, before it is grouped into hunks. */
interface DiffStep {
  marker: '+' | '-' | ' ';
  content: string;
  /** Line number in whichever side owns the step, 1-based. */
  line: number;
}

function splitLines(text: string): string[] {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized === '' ? [] : normalized.split('\n');
}

/** How many leading lines the two sides share. */
function commonPrefix(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length);
  let count = 0;
  while (count < limit && before[count] === after[count]) count += 1;
  return count;
}

/** How many trailing lines the two sides share, never overlapping the prefix. */
function commonSuffix(before: readonly string[], after: readonly string[], prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix;
  let count = 0;
  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count]) count += 1;
  return count;
}

/**
 * The classic LCS length table. Only ever called once the caller has checked
 * the region against MAX_MATRIX_CELLS, so the allocation is bounded.
 */
function lcsTable(before: readonly string[], after: readonly string[]): Uint32Array {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      const index = row * columns + column;
      table[index] =
        before[row] === after[column]
          ? (table[index + columns + 1] ?? 0) + 1
          : Math.max(table[index + columns] ?? 0, table[index + 1] ?? 0);
    }
  }
  return table;
}

/** Walks the table to turn it back into an ordered run of keeps, removals and additions. */
function backtrack(
  before: readonly string[],
  after: readonly string[],
  beforeStart: number,
  afterStart: number,
): DiffStep[] {
  const table = lcsTable(before, after);
  const columns = after.length + 1;
  const steps: DiffStep[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      steps.push({ marker: ' ', content: after[column] ?? '', line: afterStart + column });
      row += 1;
      column += 1;
      continue;
    }
    if ((table[(row + 1) * columns + column] ?? 0) >= (table[row * columns + column + 1] ?? 0)) {
      steps.push({ marker: '-', content: before[row] ?? '', line: beforeStart + row });
      row += 1;
      continue;
    }
    steps.push({ marker: '+', content: after[column] ?? '', line: afterStart + column });
    column += 1;
  }
  while (row < before.length) {
    steps.push({ marker: '-', content: before[row] ?? '', line: beforeStart + row });
    row += 1;
  }
  while (column < after.length) {
    steps.push({ marker: '+', content: after[column] ?? '', line: afterStart + column });
    column += 1;
  }
  return steps;
}

/** The whole changed region as one replacement, for a region too large to match. */
function wholesale(
  before: readonly string[],
  after: readonly string[],
  beforeStart: number,
  afterStart: number,
): DiffStep[] {
  return [
    ...before.map((content, offset) => ({ marker: '-' as const, content, line: beforeStart + offset })),
    ...after.map((content, offset) => ({ marker: '+' as const, content, line: afterStart + offset })),
  ];
}

/** Groups the steps into hunks, keeping CONTEXT_LINES of unchanged text either side of a change. */
function toHunks(steps: readonly DiffStep[]): FileEditsDiffHunk[] {
  const keep: boolean[] = Array.from({ length: steps.length }, () => false);
  for (const [index, step] of steps.entries()) {
    if (step.marker === ' ') continue;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(steps.length - 1, index + CONTEXT_LINES);
    for (let cursor = from; cursor <= to; cursor += 1) keep[cursor] = true;
  }

  const hunks: FileEditsDiffHunk[] = [];
  let rows: FileEditsDiffRow[] = [];
  for (const [index, step] of steps.entries()) {
    if (!keep[index]) {
      if (rows.length > 0) {
        hunks.push({ start: rows[0]?.line ?? 1, rows });
        rows = [];
      }
      continue;
    }
    rows.push({ marker: step.marker, line: step.line, content: step.content });
  }
  if (rows.length > 0) hunks.push({ start: rows[0]?.line ?? 1, rows });
  return hunks;
}

/**
 * The difference between two versions of a file.
 *
 * Line numbers are the new file's for context and additions, and the old
 * file's for removals, which is the pairing a reader expects: the number
 * beside a line is where that line actually lives.
 */
export function lineDiff(before: string, after: string): LineDiffResult {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const prefix = commonPrefix(beforeLines, afterLines);
  const suffix = commonSuffix(beforeLines, afterLines, prefix);
  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);

  const approximate = beforeMiddle.length * afterMiddle.length > MAX_MATRIX_CELLS;
  const middle = approximate
    ? wholesale(beforeMiddle, afterMiddle, prefix + 1, prefix + 1)
    : backtrack(beforeMiddle, afterMiddle, prefix + 1, prefix + 1);

  const head: DiffStep[] = beforeLines
    .slice(0, prefix)
    .map((content, offset) => ({ marker: ' ' as const, content, line: offset + 1 }));
  const tail: DiffStep[] = afterLines
    .slice(afterLines.length - suffix)
    .map((content, offset) => ({ marker: ' ' as const, content, line: afterLines.length - suffix + offset + 1 }));

  const steps = [...head, ...middle, ...tail];
  return {
    hunks: toHunks(steps),
    additions: steps.filter((step) => step.marker === '+').length,
    removals: steps.filter((step) => step.marker === '-').length,
    approximate,
  };
}
