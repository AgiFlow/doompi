/**
 * What a passkey is allowed to prove, and for how long.
 *
 * A session cookie is a bearer token: whoever holds the bytes is you. A passkey
 * is a private key in the device's secure enclave that never leaves it, so the
 * cookie stops being the only thing between a stolen phone and this machine.
 * The cookie does not go away, because a WebSocket cannot run a ceremony per
 * frame; what changes is that the cookie is short-lived, re-mintable with a
 * gesture rather than a QR, and insufficient on its own for the actions below.
 *
 * The crypto lives in the adapter. This file is the policy: which actions need
 * a fresh signature, how long a challenge is good for, and when a counter says
 * the credential has been cloned.
 */

/**
 * Actions that need a fresh gesture even from a live session.
 *
 * Chosen as the two escalation paths rather than everything: writing a provider
 * credential redirects the machine's model traffic, and spawning a session
 * picks an arbitrary directory to run an agent in. Putting a biometric check in
 * front of ordinary prompting or tool approval would land it in the hot loop of
 * actually using the agent, where it would be trained away within a day.
 */
export const STEP_UP_ACTIONS = ['provider.login', 'provider.logout', 'session.create'] as const;

export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

/** Short enough that a captured challenge is useless, long enough for a slow Face ID. */
export const STEP_UP_CHALLENGE_TTL_MS = 60_000;
/** A registration or sign-in ceremony the user has to complete. */
export const CEREMONY_TTL_MS = 120_000;

/**
 * Which action, if any, a request is attempting.
 *
 * Matched here rather than at each route so the list of gated operations is one
 * readable table instead of three call sites that can drift apart. Anything not
 * named is not gated, which is the safe default only because the gate is an
 * addition to the session check rather than a replacement for it.
 */
const GATED_ROUTES: readonly { method: string; pattern: RegExp; action: StepUpAction }[] = [
  { method: 'POST', pattern: /^\/api\/sessions$/u, action: 'session.create' },
  { method: 'POST', pattern: /^\/api\/auth\/logins\/[^/]+\/answer$/u, action: 'provider.login' },
  { method: 'DELETE', pattern: /^\/api\/auth\/providers\/[^/]+$/u, action: 'provider.logout' },
];

export function stepUpActionFor(method: string, path: string): StepUpAction | undefined {
  const wanted = method.toUpperCase();
  return GATED_ROUTES.find((route) => route.method === wanted && route.pattern.test(path))?.action;
}

export function isStepUpAction(value: unknown): value is StepUpAction {
  return typeof value === 'string' && (STEP_UP_ACTIONS as readonly string[]).includes(value);
}

export interface StoredCredential {
  /** Opaque handle for display and revocation. */
  id: string;
  /** The authenticator's credential id, base64url, as WebAuthn reports it. */
  credentialId: string;
  /** Base64url public key; the private half never leaves the device. */
  publicKey: string;
  /** Signature counter, for clone detection. */
  counter: number;
  transports: string[];
  label: string;
  createdAt: number;
  lastUsedAt: number;
}

export type CounterVerdict = 'ok' | 'clone-suspected';

/**
 * Whether a signature counter moved the way a real authenticator moves it.
 *
 * A counter that stays at zero means the authenticator does not implement one,
 * which is common and not a signal. A counter that goes backwards or repeats
 * while claiming to count means two things are signing with the same key, which
 * is the definition of a cloned credential.
 */
export function counterVerdict(stored: number, presented: number): CounterVerdict {
  if (stored === 0 && presented === 0) return 'ok';
  return presented > stored ? 'ok' : 'clone-suspected';
}

/** Whether a ceremony or step-up challenge is still live. */
export function challengeIsFresh(issuedAt: number, now: number, ttlMs: number): boolean {
  return now - issuedAt < ttlMs;
}

/** A quick tunnel's domain; its hostname rotates on every start. */
const ROTATING_SUFFIX = '.trycloudflare.com';
/** Dotted-quad, and the bracketed form a URL uses for v6. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * The relying party id a passkey is bound to.
 *
 * Derived from the configured tunnel hostname and nothing else, never from a
 * request header: `rpID` is the entire scope of a credential, so a caller who
 * could influence it could mint credentials against somebody else's origin.
 *
 * Three things are refused rather than accepted and regretted later:
 *
 * - A quick tunnel, whose hostname rotates on every start, so a passkey
 *   registered now would silently stop working on the next one.
 * - An IP address, which WebAuthn does not accept as a relying party id at all;
 *   registering against one fails in the browser rather than here, which is a
 *   much worse place to find out.
 * - Anything without a dot, which cannot be a public tunnel hostname.
 */
export function relyingPartyId(publicOrigin: string | undefined): string | undefined {
  if (publicOrigin === undefined) return undefined;
  let host: string;
  try {
    host = new URL(publicOrigin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.endsWith(ROTATING_SUFFIX)) return undefined;
  if (IPV4.test(host) || host.startsWith('[')) return undefined;
  if (!host.includes('.')) return undefined;
  return host;
}
