import {
  contentUrl,
  deleteUrl,
  detailUrl,
  type FileEditsDetailView,
  type FileEditsSaveView,
} from '../types/fileEditsApi.ts';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

/**
 * The page's half of this package's session API: one file's history, the
 * manual save, and the deletion. The only place the cockpit talks HTTP for a
 * file, so if the transport changes, it changes here alone.
 *
 * Every call goes through `sealedTransport` rather than `fetch`. Over a tunnel
 * a bare `fetch` hands the relay the plaintext, and what travels here is file
 * contents in both directions, which is the worst thing in the cockpit to leak.
 * On loopback the transport is a pass-through, so this costs nothing there.
 */

const UNREACHABLE = 'The session is unreachable.';
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Where a file's raw bytes are served from, for the ones the page shows rather
 * than edits.
 *
 * This is the host's route, not this package's. The cockpit already serves any
 * file under a session's working directory, for the previews an @-mention
 * raises, and that route carries the traversal guard, the size cap and the
 * content-type mapping a bytes route needs. Adding a second one here would
 * duplicate a security boundary to avoid duplicating a URL, which is the wrong
 * way round. The path is relative to the session's working directory, which is
 * the form the file list already holds.
 */
export function sessionFileUrl(sessionId: string, relPath: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(relPath)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error a route reported, or a generic one; never an empty message. */
function errorOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === 'string' && body.error !== '' ? body.error : fallback;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type FetchDetailResult = { ok: true; detail: FileEditsDetailView } | { ok: false; error: string };

export async function fetchFileDetail(sessionId: string, filePath: string): Promise<FetchDetailResult> {
  let response: Response;
  try {
    response = await sealedTransport.fetch(detailUrl(sessionId, filePath));
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = await readBody(response);
  if (!response.ok) return { ok: false, error: errorOf(body, `The session answered ${response.status}.`) };
  if (!isRecord(body)) return { ok: false, error: 'The session answered with no detail.' };
  return { ok: true, detail: body as unknown as FileEditsDetailView };
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
  let response: Response;
  try {
    response = await sealedTransport.fetch(contentUrl(sessionId), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ path: filePath, expectedHash, content }),
    });
  } catch {
    return { ok: false, stale: false, error: UNREACHABLE };
  }
  const body = await readBody(response);
  if (response.status === 409) {
    const hash = isRecord(body) && typeof body.hash === 'string' ? body.hash : undefined;
    return {
      ok: false,
      stale: true,
      error: errorOf(body, 'The file changed since it was opened.'),
      ...(hash === undefined ? {} : { hash }),
    };
  }
  if (!response.ok) {
    return { ok: false, stale: false, error: errorOf(body, `The session answered ${response.status}.`) };
  }
  const saved = body as FileEditsSaveView | undefined;
  return { ok: true, hash: saved?.hash ?? '' };
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
  let response: Response;
  try {
    response = await sealedTransport.fetch(deleteUrl(sessionId, filePath), { method: 'DELETE' });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  if (response.ok) return { ok: true };
  return { ok: false, error: errorOf(await readBody(response), `The session answered ${response.status}.`) };
}
