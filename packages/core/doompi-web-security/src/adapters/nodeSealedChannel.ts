import { ECDH, createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
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

const CURVE = 'prime256v1';
const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const HKDF_HASH = 'sha256';
/** Fixed and public: HKDF's salt need not be secret, and a constant keeps both sides in step. */
const HKDF_SALT = Buffer.from('doompi/sealed/v1');

export type SealResult = { ok: true; envelope: SealedEnvelope } | { ok: false; failure: SealedFailure };
export type OpenResult = { ok: true; plaintext: Uint8Array } | { ok: false; failure: SealedFailure };

export interface SealedChannel {
  /** Seals one message. Counters advance only on success. */
  seal(plaintext: Uint8Array): SealResult;
  open(envelope: unknown): OpenResult;
}

export interface HostHandshake {
  /** Base64url uncompressed P-256 point, printed in the QR. */
  publicKey: string;
  /** Completes the exchange against the peer's key and yields the channel. */
  accept(peerPublicKey: string): SealedChannel | undefined;
}

function derive(secret: Buffer, direction: SealedDirection): Buffer {
  return Buffer.from(hkdfSync(HKDF_HASH, secret, HKDF_SALT, Buffer.from(infoFor(direction)), KEY_BYTES));
}

/**
 * Builds the nonce for one message.
 *
 * A random per-channel prefix plus a monotonic counter, rather than a random
 * nonce per message: 96 bits is small enough that random nonces collide at a
 * rate worth caring about, and a repeated nonce under one AES-GCM key is
 * catastrophic rather than merely weak.
 */
function nonceFor(prefix: Buffer, counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  prefix.copy(nonce, 0, 0, NONCE_PREFIX_BYTES);
  nonce.writeBigUInt64BE(counter, NONCE_PREFIX_BYTES);
  return nonce;
}

/**
 * One direction's sealing state.
 *
 * Send and receive are separate keys and separate counters, so a message the
 * server sent can never be replayed back at it as though the client had sent it.
 */
function createChannel(secret: Buffer, sendDirection: SealedDirection, noncePrefix: Buffer): SealedChannel {
  const sendKey = derive(secret, sendDirection);
  const receiveKey = derive(secret, sendDirection === 'c2s' ? 's2c' : 'c2s');
  let sendCounter = 0n;
  /** Strictly increasing: anything at or below what has been seen is a replay. */
  let highestReceived = -1n;

  return {
    seal(plaintext) {
      if (sendCounter >= BigInt(MAX_MESSAGES_PER_KEY)) return { ok: false, failure: 'exhausted' };
      const nonce = nonceFor(noncePrefix, sendCounter);
      const cipher = createCipheriv(CIPHER, sendKey, nonce);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      sendCounter += 1n;
      return {
        ok: true,
        envelope: { v: SEALED_VERSION, n: nonce.toString('base64url'), c: body.toString('base64url') },
      };
    },

    open(envelope) {
      // Shape before version: something with no `v` at all is malformed, and
      // calling it a version mismatch would send a reader hunting for a
      // protocol skew that is not there.
      const shape = envelope as { v?: unknown; n?: unknown; c?: unknown } | null | undefined;
      if (typeof shape?.n !== 'string' || typeof shape.c !== 'string') return { ok: false, failure: 'malformed' };
      if (shape.v !== SEALED_VERSION) return { ok: false, failure: 'version' };
      if (!isSealedEnvelope(envelope)) return { ok: false, failure: 'malformed' };
      const nonce = Buffer.from(envelope.n, 'base64url');
      const body = Buffer.from(envelope.c, 'base64url');
      if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) return { ok: false, failure: 'malformed' };
      const counter = nonce.readBigUInt64BE(NONCE_PREFIX_BYTES);
      if (counter <= highestReceived) return { ok: false, failure: 'replay' };
      const decipher = createDecipheriv(CIPHER, receiveKey, nonce);
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
      } catch {
        // A failed tag means the message was altered, which is the whole point
        // of having one. Never fall back to the ciphertext.
        return { ok: false, failure: 'auth' };
      }
      // Advanced only after the tag verified, so a forged high counter cannot
      // lock out the messages that follow it.
      highestReceived = counter;
      return { ok: true, plaintext: new Uint8Array(plaintext) };
    },
  };
}

/**
 * The host half of the handshake.
 *
 * The ephemeral key pair is generated per tunnel and its public half goes in the
 * QR, which is the out-of-band channel that makes this authenticated. A relay
 * that swaps the client's key gets a channel with itself and nothing from the
 * host, because the host only ever derives against the key the client presents
 * and the client only ever derives against the key it read off the screen.
 */
export function createHostHandshake(): HostHandshake {
  const exchange = createECDH(CURVE);
  exchange.generateKeys();
  const acceptedPeers = new Set<string>();
  return {
    publicKey: exchange.getPublicKey().toString('base64url'),
    accept(peerPublicKey) {
      let peer: Buffer;
      let secret: Buffer;
      try {
        peer = ECDH.convertKey(Buffer.from(peerPublicKey, 'base64url'), CURVE, undefined, undefined, 'uncompressed');
        if (acceptedPeers.has(peer.toString('base64url'))) return undefined;
        secret = exchange.computeSecret(peer);
      } catch {
        // A key that is not a point on the curve; there is no channel to make.
        return undefined;
      }
      acceptedPeers.add(peer.toString('base64url'));
      // The prefix is the host's to choose and travels in every nonce, so the
      // client reads it off the wire rather than needing it up front.
      return createChannel(secret, 's2c', randomBytes(NONCE_PREFIX_BYTES));
    },
  };
}
