import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { REMOTE_API_ROUTE, STEP_UP_HEADER } from '../../types/remoteAccess.ts';

/**
 * The browser half of the passkey ceremonies.
 *
 * A session cookie is a bearer token: whoever holds the bytes is you. A passkey
 * is a key in this device's secure enclave that never leaves it, so the two
 * actions that escalate out of "drive the agent" into "own the machine" can ask
 * for a gesture instead of trusting the cookie alone.
 */

export type PasskeyOutcome = { ok: true } | { ok: false; error: string };

function describe(error: unknown): string {
  if (error instanceof Error) {
    // The user dismissing Face ID is not an error worth a stack trace.
    return error.name === 'NotAllowedError' ? 'That was cancelled.' : error.message;
  }
  return String(error);
}

export function passkeysAvailable(): boolean {
  return browserSupportsWebAuthn();
}

async function postJson(route: string, body: unknown): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) return undefined;
  const parsed: unknown = await response.json();
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
}

/** Enrols this device's passkey. Local-only on the server, so this runs at the machine. */
export async function registerPasskey(): Promise<PasskeyOutcome> {
  if (!passkeysAvailable()) return { ok: false, error: 'This browser has no passkey support.' };
  try {
    const begun = await postJson(`${REMOTE_API_ROUTE}/passkeys/register/begin`, {});
    if (begun?.options === undefined) return { ok: false, error: 'Passkeys are unavailable on this tunnel.' };
    const response = await startRegistration({ optionsJSON: begun.options as never });
    const finished = await postJson(`${REMOTE_API_ROUTE}/passkeys/register/finish`, { response });
    return finished === undefined ? { ok: false, error: 'That passkey was not accepted.' } : { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/** Trades a registered passkey for a session, so a return visit needs no QR. */
export async function signInWithPasskey(): Promise<PasskeyOutcome> {
  if (!passkeysAvailable()) return { ok: false, error: 'This browser has no passkey support.' };
  try {
    const begun = await postJson(`${REMOTE_API_ROUTE}/passkeys/authenticate/begin`, {});
    if (begun?.options === undefined) return { ok: false, error: 'Passkeys are unavailable on this tunnel.' };
    const response = await startAuthentication({ optionsJSON: begun.options as never });
    const finished = await postJson(`${REMOTE_API_ROUTE}/passkeys/authenticate/finish`, { response });
    return finished === undefined ? { ok: false, error: 'That passkey was not accepted.' } : { ok: true };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/**
 * Runs one gesture for one action and returns the header value that proves it.
 *
 * The assertion is base64url JSON because a WebAuthn response carries binary,
 * and it travels in a header rather than a body so the retry can replay the
 * original request untouched.
 */
export async function assertionFor(action: string): Promise<string | undefined> {
  if (!passkeysAvailable()) return undefined;
  try {
    const begun = await postJson(`${REMOTE_API_ROUTE}/challenge`, { action });
    if (begun?.options === undefined) return undefined;
    const response = await startAuthentication({ optionsJSON: begun.options as never });
    return btoa(JSON.stringify(response)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  } catch {
    // A dismissed or failed gesture means the action does not proceed, which
    // the caller reports; there is nothing to log here.
    return undefined;
  }
}

/** The header name a caller attaches an assertion under. */
export const STEP_UP_HEADER_NAME = STEP_UP_HEADER;
