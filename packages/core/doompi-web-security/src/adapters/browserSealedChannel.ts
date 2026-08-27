import {
  MAX_MESSAGES_PER_KEY,
  NONCE_BYTES,
  NONCE_PREFIX_BYTES,
  SEALED_VERSION,
  type SealedDirection,
  type SealedEnvelope,
  type SealedFailure,
  infoFor,
  isSealedEnvelope,
} from '../types/sealedChannel.ts';

/**
 * The browser half of the sealed channel.
 *
 * Mirrors `nodeSealedChannel.ts` exactly, on WebCrypto instead of
 * `node:crypto`. Two implementations rather than one because a shared one would
 * drag node builtins into every browser bundle that imports it, and this
 * package is imported by plugins that ship to the page. The envelope contract
 * they both read lives in `../types/sealedChannel.ts`, and a round-trip test
 * pins the two together so they cannot drift.
 */

const KEY_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const;
const CIPHER = 'AES-GCM';
const KEY_BITS = 256;
const TAG_BITS = 128;
const TAG_BYTES = 16;
const HKDF_SALT = 'doompi/sealed/v1';

export type SealResult = { ok: true; envelope: SealedEnvelope } | { ok: false; failure: SealedFailure };
export type OpenResult = { ok: true; plaintext: Uint8Array } | { ok: false; failure: SealedFailure };

export interface SealedChannel {
  seal(plaintext: Uint8Array): Promise<SealResult>;
  open(envelope: unknown): Promise<OpenResult>;
}

/** Undefined rather than a throw: a malformed field is a verdict, not an exception. */
function bytes(value: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return undefined;
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function view(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.length));
  copy.set(value);
  return copy.buffer;
}

async function derive(secret: ArrayBuffer, direction: SealedDirection): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: view(new TextEncoder().encode(HKDF_SALT)),
      info: view(new TextEncoder().encode(infoFor(direction))),
    },
    material,
    { name: CIPHER, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

function nonceFor(prefix: Uint8Array, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(prefix.subarray(0, NONCE_PREFIX_BYTES), 0);
  new DataView(nonce.buffer).setBigUint64(NONCE_PREFIX_BYTES, counter, false);
  return nonce;
}

function channelFrom(sendKey: CryptoKey, receiveKey: CryptoKey, noncePrefix: Uint8Array): SealedChannel {
  let sendCounter = 0n;
  let highestReceived = -1n;

  return {
    async seal(plaintext) {
      if (sendCounter >= BigInt(MAX_MESSAGES_PER_KEY)) return { ok: false, failure: 'exhausted' };
      const nonce = nonceFor(noncePrefix, sendCounter);
      const sealed = await crypto.subtle.encrypt(
        { name: CIPHER, iv: view(nonce), tagLength: TAG_BITS },
        sendKey,
        view(plaintext),
      );
      sendCounter += 1n;
      return {
        ok: true,
        envelope: { v: SEALED_VERSION, n: base64Url(nonce), c: base64Url(new Uint8Array(sealed)) },
      };
    },

    async open(envelope) {
      // Shape before version, matching the server: something with no `v` at all
      // is malformed rather than a protocol skew.
      const shape = envelope as { v?: unknown; n?: unknown; c?: unknown } | null | undefined;
      if (typeof shape?.n !== 'string' || typeof shape.c !== 'string') return { ok: false, failure: 'malformed' };
      if (shape.v !== SEALED_VERSION) return { ok: false, failure: 'version' };
      if (!isSealedEnvelope(envelope)) return { ok: false, failure: 'malformed' };
      const nonce = bytes(envelope.n);
      const body = bytes(envelope.c);
      if (nonce === undefined || body === undefined) return { ok: false, failure: 'malformed' };
      if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) return { ok: false, failure: 'malformed' };
      const counter = new DataView(view(nonce)).getBigUint64(NONCE_PREFIX_BYTES, false);
      if (counter <= highestReceived) return { ok: false, failure: 'replay' };
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: CIPHER, iv: view(nonce), tagLength: TAG_BITS },
          receiveKey,
          view(body),
        );
      } catch {
        // A failed tag means the message was altered in transit; there is no
        // partial result worth salvaging.
        return { ok: false, failure: 'auth' };
      }
      // Only after the tag verified, so a forged high counter cannot lock out
      // every message that legitimately follows it.
      highestReceived = counter;
      return { ok: true, plaintext: new Uint8Array(plaintext) };
    },
  };
}

/**
 * Completes the handshake against the host key read out of the QR fragment.
 *
 * That key never travelled through the tunnel, which is what makes this
 * authenticated: a relay can watch the client's public key go past and learn
 * nothing, and it cannot substitute the host's because it never carried it.
 */
export async function connectSealedChannel(
  hostPublicKey: string,
): Promise<{ channel: SealedChannel; clientPublicKey: string } | undefined> {
  if (globalThis.crypto?.subtle === undefined) return undefined;
  try {
    const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ['deriveBits']);
    const hostKey = bytes(hostPublicKey);
    if (hostKey === undefined) return undefined;
    const peer = await crypto.subtle.importKey('raw', view(hostKey), KEY_ALGORITHM, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, KEY_BITS);
    const clientPublicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    return {
      channel: channelFrom(
        await derive(secret, 'c2s'),
        await derive(secret, 's2c'),
        new Uint8Array(NONCE_PREFIX_BYTES),
      ),
      clientPublicKey,
    };
  } catch {
    // A malformed host key or a context without ECDH; the caller falls back to
    // an unsealed channel and says so rather than failing silently.
    return undefined;
  }
}

/** Exposed so a test can build the browser side against a known secret. */
export async function channelFromSecret(
  secret: ArrayBuffer,
  sendDirection: SealedDirection,
  noncePrefix: Uint8Array,
): Promise<SealedChannel> {
  const send = await derive(secret, sendDirection);
  const receive = await derive(secret, sendDirection === 'c2s' ? 's2c' : 'c2s');
  return channelFrom(send, receive, noncePrefix);
}
