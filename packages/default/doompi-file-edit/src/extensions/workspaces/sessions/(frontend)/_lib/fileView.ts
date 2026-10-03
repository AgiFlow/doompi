import { buildReviewPrompt, grammarKeyOf, mediaKindOf, type ReviewComment } from '@agimon-ai/doompi-web-components';

import type { FileEditTool } from '../../../../../types/domain';
import type { FilesItemView } from '../../../../../types/webFiles';

/**
 * Pure view logic the file surfaces share: how a change is labelled, how a
 * file is identified, and how a review reaches the agent.
 *
 * None of this touches React or the DOM beyond what it is handed, so the
 * awkward parts are pinned by tests rather than by clicking through a browser.
 * Wording a review and drawing a diff are shared with other review surfaces
 * and live in doompi-web-components.
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

/**
 * Sends a review as a deferred follow-up and reports whether it left.
 *
 * `follow_up` waits behind a running turn and starts when idle, without
 * treating the review as an explicit Queue action. The sender throws when
 * disconnected, so the caller keeps the comments and reports the reason.
 */
export function sendReviewFrame(
  send: (frame: Record<string, unknown>) => void,
  comments: readonly ReviewComment[],
): string | undefined {
  try {
    send({ type: 'follow_up', message: buildReviewPrompt(comments) });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
