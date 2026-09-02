import { type ContextItemDetail, type ContextItemKind, itemDetailUrl } from '@agimon-ai/doompi/contextApi';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

/**
 * The page's half of the runtime's context API.
 *
 * The panel prices every tool and skill from a projection small enough to
 * republish on every composition change. The prose and the schema behind a
 * figure are neither small nor wanted in bulk, so they are asked for one row at
 * a time, when a reader clicks the row.
 *
 * A session that has gone away, or one whose runtime predates this API, answers
 * 404. That is reported as text in the dialog rather than swallowed: a reader
 * who clicked deserves to know the session cannot say, instead of watching a
 * spinner forever.
 */

const UNREACHABLE = 'The session did not answer.';

export type FetchItemDetailResult = { ok: true; detail: ContextItemDetail } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function errorOf(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === 'string' && body.error !== '' ? body.error : fallback;
}

export async function fetchContextItemDetail(
  sessionId: string,
  itemKind: ContextItemKind,
  name: string,
): Promise<FetchItemDetailResult> {
  let response: Response;
  try {
    response = await sealedTransport.fetch(itemDetailUrl(sessionId, itemKind, name));
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = await readBody(response);
  if (!response.ok) return { ok: false, error: errorOf(body, `The session answered ${String(response.status)}.`) };
  if (!isRecord(body) || !isRecord(body.item)) return { ok: false, error: 'The session answered with no detail.' };
  return { ok: true, detail: body.item as unknown as ContextItemDetail };
}
