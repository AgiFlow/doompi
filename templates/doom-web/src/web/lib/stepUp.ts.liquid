import { STEP_UP_HEADER } from '../../types/remoteAccess.ts';
import { sealedHttpSession } from './sealedSession.ts';
import { assertionFor } from './webauthnClient.ts';

const UNAUTHORIZED = 401;

/**
 * Fetch that answers a step-up challenge once and retries.
 *
 * The server decides which actions need a gesture, not the client: it answers
 * 401 naming the action, and this replays the identical request with an
 * assertion attached. Keeping the decision server-side means a client that
 * forgets to ask still cannot skip the gate, and it means adding a gated action
 * needs no client change at all.
 *
 * Exactly one retry. A second 401 after a fresh gesture is a real refusal, and
 * looping would turn a denied action into a biometric prompt that will not stop.
 */
export async function fetchWithStepUp(
  input: string,
  init?: RequestInit,
  /** Test seam, in the house style: the real one runs a WebAuthn ceremony. */
  requestAssertion: (action: string) => Promise<string | undefined> = assertionFor,
): Promise<Response> {
  const first = await sealedHttpSession.fetch(input, init);
  if (first.status !== UNAUTHORIZED) return first;

  let action: unknown;
  try {
    action = ((await first.clone().json()) as { action?: unknown }).action;
  } catch {
    return first; // A 401 with no action is an ordinary refusal.
  }
  if (typeof action !== 'string') return first;

  const assertion = await requestAssertion(action);
  if (assertion === undefined) return first;

  return await sealedHttpSession.fetch(input, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), [STEP_UP_HEADER]: assertion },
  });
}
