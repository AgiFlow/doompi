import {
  BUNDLE_MANIFEST_ROUTE,
  type SignedBundleManifest,
  canonicalManifest,
  isBundleManifest,
} from '@agimon-ai/doompi-web-security';
import { restoreSealedSession, sealedHttpSession } from './sealedSession.ts';

/**
 * Checking that the page came from this hub and not from the edge in front of it.
 *
 * Cloudflare terminates TLS, so it can serve whatever JavaScript it likes, and
 * a swapped bundle would read the session cookie, drive the socket, and pass a
 * passkey ceremony on the attacker's behalf. Every other guarantee rests on
 * this one.
 *
 * The pinned key arrives over the pairing exchange and is kept in
 * `localStorage` rather than a cookie so it is never sent anywhere: it is
 * checked here, in the page, and a server that never receives it cannot lie
 * about it. Note the limit honestly, because it cannot be closed from inside a
 * browser: the very first load is delivered by the edge, so pinning starts from
 * whatever that load established.
 */

const PINNED_KEY_STORAGE = 'doompi.bundleKey';
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export type IntegrityVerdict =
  | { state: 'ok' }
  | { state: 'unavailable'; reason: string }
  | { state: 'tampered'; reason: string };

/** WebCrypto wants a view over a plain ArrayBuffer, not a possibly-shared one. */
function fromBase64Url(value: string): ArrayBuffer {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    // Private browsing with storage denied; verification degrades to
    // unavailable rather than silently passing.
    return undefined;
  }
}

export function pinnedBundleKey(): string | undefined {
  return storage()?.getItem(PINNED_KEY_STORAGE) ?? undefined;
}

/** Records the key this device will demand from every later load. */
export function pinBundleKey(publicKey: string): void {
  storage()?.setItem(PINNED_KEY_STORAGE, publicKey);
}

export function forgetBundleKey(): void {
  storage()?.removeItem(PINNED_KEY_STORAGE);
}

/**
 * Verifies the served manifest against the pinned key, pinning on first sight.
 *
 * Returns `unavailable` rather than `ok` when it cannot check, so a caller
 * never mistakes "no answer" for "verified".
 */
export async function verifyBundle(): Promise<IntegrityVerdict> {
  if (globalThis.crypto?.subtle === undefined) {
    return { state: 'unavailable', reason: 'This context has no WebCrypto.' };
  }
  let signed: SignedBundleManifest;
  try {
    await restoreSealedSession();
    const response = await sealedHttpSession.fetch(BUNDLE_MANIFEST_ROUTE, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return { state: 'unavailable', reason: `The manifest answered ${String(response.status)}.` };
    signed = (await response.json()) as SignedBundleManifest;
  } catch {
    return { state: 'unavailable', reason: 'The manifest could not be fetched.' };
  }
  if (!isBundleManifest(signed.manifest) || typeof signed.signature !== 'string') {
    return { state: 'tampered', reason: 'The manifest is not the shape this build produces.' };
  }

  const pinned = pinnedBundleKey();
  if (pinned !== undefined && pinned !== signed.publicKey) {
    // The one unambiguous signal: the hub that signed this is not the hub this
    // device paired with.
    return { state: 'tampered', reason: 'This cockpit is signed by a different key than the one you paired with.' };
  }

  let verified: boolean;
  try {
    const key = await crypto.subtle.importKey('spki', fromBase64Url(signed.publicKey), KEY_ALGORITHM, false, [
      'verify',
    ]);
    verified = await crypto.subtle.verify(
      SIGN_ALGORITHM,
      key,
      fromBase64Url(signed.signature),
      new TextEncoder().encode(canonicalManifest(signed.manifest)).buffer as ArrayBuffer,
    );
  } catch {
    return { state: 'tampered', reason: 'The manifest signature could not be checked.' };
  }
  if (!verified) return { state: 'tampered', reason: 'The manifest signature does not match its contents.' };

  if (pinned === undefined) pinBundleKey(signed.publicKey);
  return { state: 'ok' };
}
