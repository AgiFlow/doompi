import { defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import type { FileEditsDetailView } from '../types/fileEditsApi.ts';
import { filesChannelType, type FilesItemView } from '../types/webFiles.ts';

/**
 * One session's record: the hub's last report plus whatever this page does with
 * it. Records are immutable values; the reducer and every action return a new one.
 *
 * Detail is cached per file rather than per open tab, because a reader closes a
 * file and comes back to it, and refetching the same history for the same click
 * is work the session already did.
 */
export interface FilesSession {
  items: FilesItemView[];
  /** One file's fetched history, keyed by absolute path. */
  detail: Readonly<Record<string, FileEditsDetailView>>;
  /** Paths with a detail request in flight, so a panel can say it is loading. */
  loading: readonly string[];
  /** What a failed fetch or a refused save reported, keyed by absolute path. */
  errors: Readonly<Record<string, string>>;
  /** Review notes waiting to be sent, in the order they were written. */
  comments: readonly FileComment[];
}

/**
 * One note anchored to a range a reader selected.
 *
 * Line numbers come from the diff and source views, where a selection maps onto
 * real lines. A note taken in the rendered preview carries its quoted text and
 * no lines, because a DOM selection there cannot be mapped back to the source
 * with any honesty.
 */
export interface FileComment {
  id: string;
  path: string;
  relPath: string;
  startLine?: number;
  endLine?: number;
  snippet: string;
  body: string;
}

const empty: FilesSession = { items: [], detail: {}, loading: [], errors: {}, comments: [] };

export const files = defineSessionStore<FilesSession>(empty);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItem(value: unknown): value is FilesItemView {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.relPath === 'string' &&
    typeof value.tool === 'string' &&
    typeof value.at === 'number' &&
    typeof value.count === 'number'
  );
}

export interface FilesPayload {
  items: FilesItemView[];
}

/** The plugin's session data channel: 'file_edits' payloads into the store. */
export const filesChannel = files.channel<FilesPayload>({
  channel: filesChannelType,
  parse(input) {
    if (!isRecord(input) || !Array.isArray(input.items)) return null;
    return { items: input.items.filter(isItem) };
  },
  // Only the list is replaced. The cached detail and the pending notes belong
  // to files a reader opened, not to the list: a file the session deletes stops
  // being listed, and pruning here would blank the tab still open on it and
  // then refetch it on the next frame.
  reduce: (current, { items }) => ({ ...current, items }),
});

export function markLoading(sessionId: string, filePath: string): void {
  files.update(sessionId, (current) =>
    current.loading.includes(filePath)
      ? current
      : { ...current, loading: [...current.loading, filePath], errors: withoutKey(current.errors, filePath) },
  );
}

export function storeDetail(sessionId: string, detail: FileEditsDetailView): void {
  files.update(sessionId, (current) => ({
    ...current,
    detail: { ...current.detail, [detail.path]: detail },
    loading: current.loading.filter((path) => path !== detail.path),
    errors: withoutKey(current.errors, detail.path),
  }));
}

export function storeError(sessionId: string, filePath: string, message: string): void {
  files.update(sessionId, (current) => ({
    ...current,
    loading: current.loading.filter((path) => path !== filePath),
    errors: { ...current.errors, [filePath]: message },
  }));
}

export function addComment(sessionId: string, comment: FileComment): void {
  files.update(sessionId, (current) => ({ ...current, comments: [...current.comments, comment] }));
}

export function removeComment(sessionId: string, id: string): void {
  files.update(sessionId, (current) => ({
    ...current,
    comments: current.comments.filter((comment) => comment.id !== id),
  }));
}

export function clearComments(sessionId: string, filePath: string): void {
  files.update(sessionId, (current) => ({
    ...current,
    comments: current.comments.filter((comment) => comment.path !== filePath),
  }));
}

function withoutKey(source: Readonly<Record<string, string>>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(([entry]) => entry !== key));
}
