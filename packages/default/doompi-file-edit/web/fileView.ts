import { grammarKeyOf, mediaKindOf } from '@agimon-ai/doompi-web-components';
import type { FileEditTool } from '../src/types/domain.ts';
import type { FileEditsDiffHunk } from '../src/types/fileEditsApi.ts';
import type { FilesItemView } from '../src/types/webFiles.ts';
import type { FileComment } from './filesStore.ts';

/**
 * Pure view logic the file surfaces share: how a change is labelled, how a
 * file is identified, and how a set of notes becomes one message.
 *
 * None of this touches React or the DOM beyond what it is handed, so the
 * awkward parts (wording a review, sizing a gutter) are pinned by tests rather
 * than by clicking through a browser.
 */

/** What a row says about the tool behind a change. */
export const TOOL_LABEL: Readonly<Record<FileEditTool, string>> = {
  edit: 'edit',
  write: 'write',
  bash: 'command',
  user: 'you',
};

/** Filters visible relative paths without changing the timeline's newest-first order. */
export function filterFileItems(items: readonly FilesItemView[], query: string): FilesItemView[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [...items];
  return items.filter((item) => item.relPath.toLocaleLowerCase().includes(normalized));
}

/**
 * How the preview shows a file: as the thing it is, wherever the browser can.
 *
 * One value rather than a chain of checks at the call site, because the order
 * carries the decisions. Media comes first, so a PNG the snapshot store
 * refused as binary is still a picture rather than an apology. `unavailable`
 * comes next, since a file with no readable text has nothing for the rest of
 * the list to render. Then the two documents that have a rendering of their
 * own, and then code, which is shown highlighted rather than as flat text.
 */
export type PreviewMode = 'media' | 'unavailable' | 'markdown' | 'html' | 'code' | 'text';

export function previewModeOf(filePath: string, unavailable: boolean): PreviewMode {
  if (mediaKindOf(filePath) !== 'download') return 'media';
  if (unavailable) return 'unavailable';
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return grammarKeyOf(filePath) === undefined ? 'text' : 'code';
}

/** A short, stable fingerprint of a string; enough to separate two paths in an id. */
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** The transient tab id for one file; stable, so reopening focuses rather than duplicates. */
export function fileTabId(filePath: string): string {
  // The id reaches a URL, so anything outside the safe set becomes a dash, and
  // the path's own fingerprint keeps two similarly-named files apart.
  const slug = filePath.replaceAll(/[^a-zA-Z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  return `files-file-${fingerprint(filePath)}-${slug.slice(-40)}`;
}

/** The widest line number in a diff, in characters, which sizes the gutter. */
export function gutterWidth(hunks: readonly FileEditsDiffHunk[]): number {
  let widest = 1;
  for (const hunk of hunks) {
    for (const row of hunk.rows) widest = Math.max(widest, String(row.line).length);
  }
  return widest;
}

/** Trims a quoted snippet to something a prompt can carry without drowning it. */
export function trimSnippet(snippet: string, maxLines = 20, maxChars = 2000): string {
  const lines = snippet.split('\n');
  const clipped = lines.length > maxLines ? [...lines.slice(0, maxLines), '…'] : lines;
  const text = clipped.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** How a comment names the place it is about. */
export function commentAnchor(comment: FileComment): string {
  if (comment.startLine === undefined) return comment.relPath;
  if (comment.endLine === undefined || comment.endLine === comment.startLine) {
    return `${comment.relPath}:${comment.startLine}`;
  }
  return `${comment.relPath}:${comment.startLine}-${comment.endLine}`;
}

/**
 * The one message a review sends.
 *
 * Every note goes in a single prompt rather than one message each: N notes then
 * cost one turn, and the agent sees the whole review before it changes
 * anything, which is the difference between addressing a review and reacting to
 * its first line.
 */
export function buildReviewPrompt(comments: readonly FileComment[]): string {
  if (comments.length === 0) return '';
  const heading =
    comments.length === 1
      ? 'I left one review comment on a file you changed. Please address it.'
      : `I left ${comments.length} review comments on files you changed. Please address them.`;
  const body = comments
    .map((comment) => {
      const quoted = trimSnippet(comment.snippet)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `### ${commentAnchor(comment)}\n\n${quoted}\n\n${comment.body.trim()}`;
    })
    .join('\n\n');
  return `${heading}\n\n${body}`;
}
