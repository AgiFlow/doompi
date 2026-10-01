/**
 * The shapes a diff and a review comment take on screen.
 *
 * A row carries one line number, and which file it belongs to follows from the
 * marker: the new file's for context and additions, the old file's for
 * removals. That is what lets a comment on a removed line point at the old
 * file instead of at an unrelated line of the new one.
 */

/** Which file a line number belongs to. */
export type DiffSide = 'old' | 'new';

export type DiffMarker = '+' | '-' | ' ';

/** One line of a diff: new-side number for context and additions, old-side for removals. */
export interface DiffRow {
  marker: DiffMarker;
  line: number;
  content: string;
}

/** A run of changed lines with its context. Hunks arrive apart; the view draws the gap. */
export interface DiffHunk {
  start: number;
  rows: readonly DiffRow[];
}

/** What a reader picked: a line range on one side, and the text they highlighted. */
export interface DiffSelection {
  side: DiffSide;
  startLine: number;
  endLine: number;
  snippet: string;
}

/** One review note, anchored to lines on one side, or to a quoted selection with no lines. */
export interface ReviewComment {
  id: string;
  /** The file's identity for the owner: an absolute path, or the repository-relative one. */
  path: string;
  /** What the message names the file by. */
  relPath: string;
  /** Absent means the new side, which is what every anchor meant before sides existed. */
  side?: DiffSide;
  startLine?: number;
  endLine?: number;
  snippet: string;
  body: string;
}
