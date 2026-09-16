import { api } from '../../../../../../../generated/client';
import type { PlanDetailView } from '../../../../../../types/planApi';

/**
 * The page's half of this package's session API: the current plan, and the
 * manual save.
 *
 * These are adapters now, not a transport. The generated client owns the URL
 * and the sealed transport with it, so nothing here spells a route or reaches
 * for `fetch`. What stays is this package's own vocabulary: which refusals the
 * reader is shown, and the stale-save contract the editor depends on.
 */

const UNREACHABLE = 'The session is unreachable.';
const NO_PLAN = 'This session has not written a plan yet.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message a reader is shown: the route's own words, or why there were none. */
function messageOf(result: { status: number; error: string }): string {
  if (result.status === 0) return UNREACHABLE;
  return result.error === '' ? `The session answered ${String(result.status)}.` : result.error;
}

export type FetchPlanResult = { ok: true; detail: PlanDetailView } | { ok: false; error: string };

export async function fetchPlan(sessionId: string): Promise<FetchPlanResult> {
  const result = await api.session(sessionId).current();
  // A session that has written nothing answers 404, which is not a failure the
  // reader should be shown as one.
  if (result.status === 404) return { ok: false, error: result.ok || result.error === '' ? NO_PLAN : result.error };
  if (!result.ok) return { ok: false, error: messageOf(result) };
  if (!isRecord(result.data)) return { ok: false, error: 'The session answered with no plan.' };
  return { ok: true, detail: result.data };
}

export type SavePlanResult =
  | { ok: true; hash: string }
  /** The plan moved under the editor; `hash` is what it holds now. */
  | { ok: false; stale: true; error: string; hash?: string }
  | { ok: false; stale: false; error: string };

export async function savePlan(sessionId: string, expectedHash: string, content: string): Promise<SavePlanResult> {
  const result = await api.session(sessionId).save({ body: { expectedHash, content } });
  // The agent can rewrite the plan while a reader is still editing it. A moved
  // hash is the one refusal the editor recovers from, so it is read before the
  // generic failure.
  if (result.status === 409) {
    const data = result.ok ? undefined : result.data;
    const hash = isRecord(data) && typeof data.hash === 'string' ? data.hash : undefined;
    return {
      ok: false,
      stale: true,
      error: result.ok ? 'The plan changed since it was opened.' : messageOf(result),
      ...(hash === undefined ? {} : { hash }),
    };
  }
  if (!result.ok) return { ok: false, stale: false, error: messageOf(result) };
  return { ok: true, hash: isRecord(result.data) && typeof result.data.hash === 'string' ? result.data.hash : '' };
}
