import type { FileEditOrigin, FileEditTool } from './domain.ts';

/**
 * The wire vocabulary this package's API shares with whatever calls it.
 *
 * It lives under src/types because that is the one server root a browser
 * bundle may read: the cockpit plugin builds its URLs from these and the
 * routes answer them, so neither half can drift from the other.
 *
 * Three routes. Opening a changed file wants its whole history at once, so
 * `detail` answers in one round trip rather than making the page stitch three
 * reads together; `content` takes the manual save back; `preview` reads a file
 * the session never changed, which has no history to answer with.
 */

/** Where a host mounts this package's API; the segment after /api/plugin/. */
export const API_BASE_PATH = 'file-edits';

/** Query parameter the cockpit hub reads to pick which session server to proxy to. */
export const SESSION_QUERY_PARAM = 'session';

/** Query parameter naming the file a request is about. */
export const PATH_QUERY_PARAM = 'path';

/** One file's whole detail, relative to the API's own mount. */
export function detailPath(): string {
  return '/detail';
}

/** The manual save, and the deletion, relative to the API's own mount. */
export function contentPath(): string {
  return '/content';
}

/** One unchanged file, read only, relative to the API's own mount. */
export function previewPath(): string {
  return '/preview';
}

/**
 * The absolute URL a page fetches, through the hub. The whole query is built
 * here, session parameter included, so a caller never appends a second '?'.
 */
export function detailUrl(sessionId: string, filePath: string): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId, [PATH_QUERY_PARAM]: filePath });
  return `/api/plugin/${API_BASE_PATH}${detailPath()}?${search.toString()}`;
}

/** The absolute URL a page puts a manual save to. */
export function contentUrl(sessionId: string): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId });
  return `/api/plugin/${API_BASE_PATH}${contentPath()}?${search.toString()}`;
}

/** The absolute URL a page reads an unchanged file through. */
export function previewUrl(sessionId: string, filePath: string): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId, [PATH_QUERY_PARAM]: filePath });
  return `/api/plugin/${API_BASE_PATH}${previewPath()}?${search.toString()}`;
}

/** The absolute URL a page deletes a file through; the path rides the query, not a body. */
export function deleteUrl(sessionId: string, filePath: string): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId, [PATH_QUERY_PARAM]: filePath });
  return `/api/plugin/${API_BASE_PATH}${contentPath()}?${search.toString()}`;
}

/**
 * One line of a diff. The number is the new file's for context and additions
 * and the old file's for removals, so it always says where the line lives.
 */
export interface FileEditsDiffRow {
  marker: '+' | '-' | ' ';
  line: number;
  content: string;
}

/**
 * A run of changed lines with its surrounding context. Hunks are sent apart
 * rather than joined by an elision marker, so the page draws the gap between
 * them instead of parsing one out of a string.
 */
export interface FileEditsDiffHunk {
  /** The line number the hunk opens at. */
  start: number;
  rows: FileEditsDiffRow[];
}

/**
 * One change in a file's history, each rendered on its own so a file edited
 * four times shows four distinct diffs rather than one merged blur.
 */
export interface FileEditsVersionView {
  /** Position in the file's history, oldest first, starting at 1. */
  index: number;
  tool: FileEditTool;
  at: number;
  origin: FileEditOrigin;
  additions: number;
  removals: number;
  /** The changed lines of this one change; absent when no baseline was captured. */
  hunks?: FileEditsDiffHunk[];
  /** Why there is no diff, shown in its place. */
  note?: string;
}

/** Everything this session did to the file: its first baseline against what is on disk now. */
export interface FileEditsCumulativeView {
  additions: number;
  removals: number;
  hunks?: FileEditsDiffHunk[];
  note?: string;
}

/** The file as it stands on disk right now, which is what the source view edits. */
export interface FileEditsWorkingView {
  content: string;
  /** sha256 of the content; the token a save hands back to prove it is not stale. */
  hash: string;
  /** True when the file is binary, missing, or past the size cap, so `content` is empty. */
  unavailable: boolean;
  reason?: string;
}

/** What the detail route answers with. */
export interface FileEditsDetailView {
  path: string;
  relPath: string;
  versions: FileEditsVersionView[];
  cumulative: FileEditsCumulativeView;
  working: FileEditsWorkingView;
}

/**
 * What the preview route answers with: the file as it stands, and nothing
 * about how it got there. A file this session never touched has no history and
 * no baseline, so there is no diff to send and no save to take back.
 */
export interface FileEditsPreviewView {
  path: string;
  relPath: string;
  working: FileEditsWorkingView;
}

/** What the save route takes. */
export interface FileEditsSaveRequest {
  path: string;
  /** The hash the reader loaded; a mismatch means the file moved underneath them. */
  expectedHash: string;
  content: string;
}

/** What the save route answers with. */
export interface FileEditsSaveView {
  hash: string;
}

/** What a route reports when it refuses; the page shows `error` verbatim. */
export interface FileEditsErrorView {
  error: string;
  /** On a stale save, the hash the file actually has now. */
  hash?: string;
}
