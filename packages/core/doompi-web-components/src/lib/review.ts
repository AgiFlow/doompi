import type { DiffHunk, DiffMarker, DiffSide, ReviewComment } from '../types/diff';

/**
 * Pure review logic shared by every surface that comments on a diff: sizing a
 * gutter, deciding which side a selection is on, naming an anchor, and folding
 * a set of notes into one message.
 */

/** The widest line number in a diff, in characters, which sizes the gutter. */
export function diffGutterWidth(hunks: readonly DiffHunk[]): number {
  let widest = 1;
  for (const hunk of hunks) {
    for (const row of hunk.rows) widest = Math.max(widest, String(row.line).length);
  }
  return widest;
}

/**
 * The line range a set of touched rows covers, and the side it is on.
 *
 * Any context or added row puts the selection on the new side, and then the
 * removed rows in it are ignored: their numbers belong to the other file and
 * would stretch the range over lines that have nothing to do with it. Only a
 * selection made entirely of removed rows lands on the old side.
 */
export function diffRangeOf(
  rows: readonly { marker: DiffMarker; line: number }[],
): { side: DiffSide; startLine: number; endLine: number } | undefined {
  const numbered = rows.filter((row) => Number.isFinite(row.line) && row.line > 0);
  const kept = numbered.filter((row) => row.marker !== '-');
  const side: DiffSide = kept.length > 0 ? 'new' : 'old';
  const lines = (kept.length > 0 ? kept : numbered).map((row) => row.line);
  if (lines.length === 0) return undefined;
  return { side, startLine: Math.min(...lines), endLine: Math.max(...lines) };
}

/** Trims a quoted snippet to something a prompt can carry without drowning it. */
export function trimSnippet(snippet: string, maxLines = 20, maxChars = 2000): string {
  const lines = snippet.split('\n');
  const clipped = lines.length > maxLines ? [...lines.slice(0, maxLines), '…'] : lines;
  const text = clipped.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** How a comment names the place it is about. New-side anchors keep the `path:line` form. */
export function reviewCommentAnchor(comment: ReviewComment): string {
  if (comment.startLine === undefined) return comment.relPath;
  const single = comment.endLine === undefined || comment.endLine === comment.startLine;
  if (comment.side === 'old') {
    return single
      ? `${comment.relPath} (removed line ${comment.startLine})`
      : `${comment.relPath} (removed lines ${comment.startLine}-${comment.endLine})`;
  }
  return single
    ? `${comment.relPath}:${comment.startLine}`
    : `${comment.relPath}:${comment.startLine}-${comment.endLine}`;
}

/** The opening line of a review when the caller names no context of its own. */
export function defaultReviewHeading(count: number): string {
  return count === 1
    ? 'I left one review comment on a file you changed. Please address it.'
    : `I left ${count} review comments on files you changed. Please address them.`;
}

/**
 * The one message a review sends.
 *
 * Every note goes in a single message rather than one each: N notes then cost
 * one turn, and the agent sees the whole review before it changes anything.
 */
export function buildReviewPrompt(comments: readonly ReviewComment[], heading?: string): string {
  if (comments.length === 0) return '';
  const body = comments
    .map((comment) => {
      const quoted = trimSnippet(comment.snippet)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `### ${reviewCommentAnchor(comment)}\n\n${quoted}\n\n${comment.body.trim()}`;
    })
    .join('\n\n');
  return `${heading ?? defaultReviewHeading(comments.length)}\n\n${body}`;
}
