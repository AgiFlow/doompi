import { api } from '../../../../../../generated/client';
import {
  type FileEditsDetailView,
  type FileEditsPreviewView,
  PATH_QUERY_PARAM,
} from '../../../../../types/fileEditsApi';

/**
 * The page's half of this package's session API: one file's history, the
 * manual save, and the deletion.
 *
 * These are adapters now, not a transport. The generated client owns the URL
 * and the sealed transport with it, so nothing here spells a route or reaches
 * for `fetch`. What stays is this package's own vocabulary: which refusals the
 * reader is shown, and the stale-save contract the editor depends on.
 *
 * Sealing still matters and still happens, one layer down. What travels here is
 * file contents in both directions, which is the worst thing in the cockpit to
 * hand a tunnel's relay in the clear.
 */

const UNREACHABLE = 'The session is unreachable.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Where a file's raw bytes are served from, for the ones the page shows rather
 * than edits.
 *
 * This is the host's route, not this package's, which is why the route table
 * marks it `host: true` and it lands beside the session rather than under
 * `/plugins`. The cockpit already serves any file under a session's working
 * directory, and that route carries the traversal guard, the size cap and the
 * content-type mapping. A second one here would duplicate a security boundary
 * to avoid duplicating a URL, which is the wrong way round.
 */
export function sessionFileUrl(sessionId: string, relPath: string): string {
  return api.session(sessionId).file.url({ query: { [PATH_QUERY_PARAM]: relPath } });
}

/** The message a reader is shown: the route's own words, or why there were none. */
function messageOf(result: { status: number; error: string }): string {
  if (result.status === 0) return UNREACHABLE;
  return result.error === '' ? `The session answered ${result.status}.` : result.error;
}

export type FetchDetailResult = { ok: true; detail: FileEditsDetailView } | { ok: false; error: string };

export async function fetchFileDetail(sessionId: string, filePath: string): Promise<FetchDetailResult> {
  const result = await api.session(sessionId).detail({ query: { [PATH_QUERY_PARAM]: filePath } });
  if (!result.ok) return { ok: false, error: messageOf(result) };
  if (!isRecord(result.data)) return { ok: false, error: 'The session answered with no detail.' };
  return { ok: true, detail: result.data };
}

export type FetchPreviewResult = { ok: true; preview: FileEditsPreviewView } | { ok: false; error: string };

/** One file the session never changed, read only; the route bounds it to the working directory. */
export async function fetchFilePreview(sessionId: string, filePath: string): Promise<FetchPreviewResult> {
  const result = await api.session(sessionId).preview({ query: { [PATH_QUERY_PARAM]: filePath } });
  if (!result.ok) return { ok: false, error: messageOf(result) };
  if (!isRecord(result.data)) return { ok: false, error: 'The session answered with no file.' };
  return { ok: true, preview: result.data };
}

export type SaveResult =
  | { ok: true; hash: string }
  /** The file moved under the editor; `hash` is what it holds now. */
  | { ok: false; stale: true; error: string; hash?: string }
  | { ok: false; stale: false; error: string };

export async function saveFileContent(
  sessionId: string,
  filePath: string,
  expectedHash: string,
  content: string,
): Promise<SaveResult> {
  const result = await api.session(sessionId).save({ body: { path: filePath, expectedHash, content } });
  // The agent runs in the same working directory, so it can rewrite the file
  // while a reader is still editing it. A moved hash is the one refusal the
  // editor recovers from, so it is read before the generic failure.
  if (result.status === 409) {
    const data = result.ok ? undefined : result.data;
    const hash = isRecord(data) && typeof data.hash === 'string' ? data.hash : undefined;
    return {
      ok: false,
      stale: true,
      error: result.ok ? 'The file changed since it was opened.' : messageOf(result),
      ...(hash === undefined ? {} : { hash }),
    };
  }
  if (!result.ok) return { ok: false, stale: false, error: messageOf(result) };
  return { ok: true, hash: isRecord(result.data) && typeof result.data.hash === 'string' ? result.data.hash : '' };
}

export type DeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Removes the file from disk.
 *
 * The route takes only a path, with no hash to prove the reader saw what is
 * there now: a deletion discards the file whatever it holds, so a staleness
 * check would guard nothing. The confirmation in front of it is the guard.
 */
export async function deleteFile(sessionId: string, filePath: string): Promise<DeleteResult> {
  const result = await api.session(sessionId).remove({ query: { [PATH_QUERY_PARAM]: filePath } });
  return result.ok ? { ok: true } : { ok: false, error: messageOf(result) };
}
