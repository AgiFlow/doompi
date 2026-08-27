/**
 * The envelope that keeps the tunnel provider out of the payload.
 *
 * Cloudflare terminates TLS at its edge, so everything the cockpit carries
 * (prompts, file previews, model output) is plaintext to them. Sealing the
 * payload underneath their TLS leaves them a relay that can see timing and
 * sizes but not content.
 *
 * The key exchange is anchored on the QR rather than negotiated in band: the
 * host's ephemeral public key is printed on a screen the user is holding, so
 * there is no moment at which a relay could substitute its own. That is the
 * same job Telegram's emoji comparison does for a secret chat, except it
 * happens automatically instead of depending on two people comparing pictures.
 *
 * Declared here because the server seals with `node:crypto` and the browser
 * unseals with WebCrypto, and an envelope is only an envelope if both sides
 * read it identically.
 */

/** Bumped when the envelope layout changes; a mismatch is refused, never guessed at. */
export const SEALED_VERSION = 1;

/** Fragment key in the pairing URL carrying the host's ephemeral public key. */
export const SEALED_KEY_PARAM = 'k';

/** AES-GCM standard nonce length. Longer is non-standard, shorter is unsafe. */
export const NONCE_BYTES = 12;
/** Random per-channel prefix, so two channels never share a nonce space. */
export const NONCE_PREFIX_BYTES = 4;
/** Monotonic per-direction counter filling the rest of the nonce. */
export const NONCE_COUNTER_BYTES = NONCE_BYTES - NONCE_PREFIX_BYTES;

/**
 * Rekey well before the counter could wrap.
 *
 * A repeated nonce under one AES-GCM key is catastrophic, not merely weak: it
 * leaks the XOR of two plaintexts and the authentication subkey. The counter is
 * 64 bits, so this bound is nowhere near it; the point is that the bound exists
 * and is enforced rather than assumed.
 */
export const MAX_MESSAGES_PER_KEY = 2 ** 32;

/**
 * HKDF info strings, one per direction.
 *
 * Separate keys per direction, not one shared key, so a message the server sent
 * can never be replayed back at it as though the client had sent it.
 */
export const CLIENT_TO_SERVER_INFO = 'doompi/sealed/c2s/v1';
export const SERVER_TO_CLIENT_INFO = 'doompi/sealed/s2c/v1';

export type SealedDirection = 'c2s' | 's2c';

export function infoFor(direction: SealedDirection): string {
  return direction === 'c2s' ? CLIENT_TO_SERVER_INFO : SERVER_TO_CLIENT_INFO;
}

/**
 * One sealed message, as it travels.
 *
 * Base64url rather than binary so the same envelope works on a JSON body and a
 * text WebSocket frame without a second encoding path to get wrong.
 */
export interface SealedEnvelope {
  v: number;
  /** Base64url, 4-byte prefix plus 8-byte counter. */
  n: string;
  /** Base64url ciphertext with the GCM tag appended. */
  c: string;
}

export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SealedEnvelope>;
  return candidate.v === SEALED_VERSION && typeof candidate.n === 'string' && typeof candidate.c === 'string';
}

/** Header naming the client's ephemeral public key during the handshake. */
export const SEALED_CLIENT_KEY_HEADER = 'x-doompi-channel-key';
/** Header carrying a sealed request body's envelope on a non-JSON request. */
export const SEALED_BODY_HEADER = 'x-doompi-sealed';

export type SealedFailure = 'version' | 'malformed' | 'replay' | 'auth' | 'exhausted';

/**
 * Why an unseal failed, in words a diagnostic can show.
 *
 * A decryption failure means a blank cockpit, so every one of these has to name
 * its cause rather than leaving a dead page and no explanation.
 */
export function describeSealedFailure(failure: SealedFailure): string {
  switch (failure) {
    case 'version':
      return 'The other end is speaking a different envelope version.';
    case 'malformed':
      return 'A sealed message was not shaped like one.';
    case 'replay':
      return 'A sealed message arrived out of order or twice.';
    case 'auth':
      return 'A sealed message failed its authentication tag, so it was altered in transit.';
    case 'exhausted':
      return 'This channel reached its message limit and must be re-established.';
  }
}
