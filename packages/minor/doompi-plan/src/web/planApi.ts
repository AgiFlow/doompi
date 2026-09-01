import { contentUrl, currentUrl, type PlanDetailView, type PlanSaveView } from '../types/planApi.ts';

/**
 * The page's half of this package's session API: the current plan, and the
 * manual save. The only place the cockpit talks HTTP for a plan, so if the
 * transport changes, it changes here alone.
 */

const UNREACHABLE = 'The session is unreachable.';
const NO_PLAN = 'This session has not written a plan yet.';
const JSON_HEADERS = { 'content-type': 'application/json' };

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

export type FetchPlanResult = { ok: true; detail: PlanDetailView } | { ok: false; error: string };

export async function fetchPlan(sessionId: string): Promise<FetchPlanResult> {
  let response: Response;
  try {
    response = await fetch(currentUrl(sessionId));
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = await readBody(response);
  if (response.status === 404) return { ok: false, error: errorOf(body, NO_PLAN) };
  if (!response.ok) return { ok: false, error: errorOf(body, `The session answered ${String(response.status)}.`) };
  if (!isRecord(body)) return { ok: false, error: 'The session answered with no plan.' };
  return { ok: true, detail: body as unknown as PlanDetailView };
}

export type SavePlanResult =
  | { ok: true; hash: string }
  /** The plan moved under the editor; `hash` is what it holds now. */
  | { ok: false; stale: true; error: string; hash?: string }
  | { ok: false; stale: false; error: string };

export async function savePlan(sessionId: string, expectedHash: string, content: string): Promise<SavePlanResult> {
  let response: Response;
  try {
    response = await fetch(contentUrl(sessionId), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ expectedHash, content }),
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
      error: errorOf(body, 'The plan changed since it was opened.'),
      ...(hash === undefined ? {} : { hash }),
    };
  }
  if (!response.ok) {
    return { ok: false, stale: false, error: errorOf(body, `The session answered ${String(response.status)}.`) };
  }
  const saved = body as PlanSaveView | undefined;
  return { ok: true, hash: saved?.hash ?? '' };
}
