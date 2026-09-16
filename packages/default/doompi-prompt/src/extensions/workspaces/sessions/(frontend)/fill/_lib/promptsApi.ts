import { api } from '../../../../../../../generated/client';
import { NAME_PARAM } from '../../../../../../constants/promptsApi';
import type { SavedPromptView } from '../../../../../../types/webPrompts';

/**
 * The browser half of the prompt library API.
 *
 * DESIGN PATTERNS:
 * - The generated client owns every URL and picks the scope, so nothing here
 *   spells a mount. Passing a session id selects the session's own copy of the
 *   API; passing none addresses the hub, which is the same branch the deleted
 *   URL builder made by hand.
 * - Failures come back as values, never thrown: the panel shows one message
 *   next to the thing that failed instead of losing the page to an error.
 * - Every call still travels over the sealed transport, which is what the
 *   client is built on, so a remote listener gets the protection the host
 *   expects either way.
 *
 * AVOID:
 * - Caching answers in this module. The panel owns state.
 */

const UNREACHABLE = 'The hub did not answer.';

interface Failure {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The hub, or one session's own copy of it; a null session id is the hub. */
function scoped(sessionId?: string | null) {
  return sessionId == null ? api.global : api.session(sessionId);
}

/** The message a reader is shown for a refused call: the route's own words, or the status. */
function messageOf(result: { status: number; error: string }): string {
  return result.error === '' ? `The hub answered ${String(result.status)}.` : result.error;
}

export async function fetchSavedPrompts(
  signal?: AbortSignal,
  sessionId?: string | null,
): Promise<{ prompts: readonly SavedPromptView[] } | Failure> {
  const result = await scoped(sessionId).list(signal ? { signal } : {});
  if (!result.ok) {
    // Status 0 is the transport never answering, which covers both a dead hub
    // and the caller replacing this request. An abort is the caller's own doing
    // and is reported as no answer rather than as a failure to show.
    if (result.status === 0) return { error: signal?.aborted === true ? '' : UNREACHABLE };
    return { error: messageOf(result) };
  }
  if (!isRecord(result.data)) return { error: 'The hub sent a malformed prompt list.' };
  const prompts = result.data.prompts;
  return { prompts: Array.isArray(prompts) ? (prompts as readonly SavedPromptView[]) : [] };
}

export async function saveSavedPrompt(
  name: string,
  text: string,
  sessionId?: string | null,
): Promise<Failure | undefined> {
  const result = await scoped(sessionId).save({ params: { [NAME_PARAM]: name }, body: { text } });
  return result.ok ? undefined : { error: result.status === 0 ? UNREACHABLE : messageOf(result) };
}

export async function deleteSavedPrompt(name: string, sessionId?: string | null): Promise<Failure | undefined> {
  const result = await scoped(sessionId).remove({ params: { [NAME_PARAM]: name } });
  return result.ok ? undefined : { error: result.status === 0 ? UNREACHABLE : messageOf(result) };
}
