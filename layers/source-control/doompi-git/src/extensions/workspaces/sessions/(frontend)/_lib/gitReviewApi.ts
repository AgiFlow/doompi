import { api } from '../../../../../../generated/client';
import type { GitReviewFileDiff, GitReviewSummary } from '../../../../../types/gitReview';

/**
 * The review tab's half of the session API: the changed-file list and one
 * file's hunks.
 *
 * The generated client owns the URL and the sealed transport, so nothing here
 * spells a route or reaches for `fetch`. What travels is file contents, which a
 * tunnel's relay must never see in the clear.
 */

const UNREACHABLE = 'The session is unreachable.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message a reader is shown: the route's own words, or why there were none. */
function messageOf(result: { status: number; error: string }): string {
  if (result.status === 0) return UNREACHABLE;
  return result.error === '' ? `The session answered ${String(result.status)}.` : result.error;
}

export type ReviewSummaryResult = { ok: true; summary: GitReviewSummary } | { ok: false; error: string };

export async function fetchReviewSummary(sessionId: string, signal?: AbortSignal): Promise<ReviewSummaryResult> {
  const result = await api.session(sessionId).review(signal === undefined ? {} : { signal });
  if (!result.ok) return { ok: false, error: messageOf(result) };
  if (!isRecord(result.data) || !Array.isArray(result.data.files)) {
    return { ok: false, error: 'The session answered with no file list.' };
  }
  return { ok: true, summary: result.data };
}

export type ReviewFileResult = { ok: true; diff: GitReviewFileDiff } | { ok: false; error: string };

export async function fetchReviewFile(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ReviewFileResult> {
  const result = await api
    .session(sessionId)
    .reviewFile({ query: { path }, ...(signal === undefined ? {} : { signal }) });
  if (!result.ok) return { ok: false, error: messageOf(result) };
  if (!isRecord(result.data) || !Array.isArray(result.data.hunks)) {
    return { ok: false, error: 'The session answered with no diff.' };
  }
  return { ok: true, diff: result.data };
}
