import { createSerialQueue } from '../services/serialQueue.ts';
import { SEALED_BODY_HEADER, describeSealedFailure, type SealedFailure } from '../types/sealedChannel.ts';
import { connectSealedChannel, type SealedChannel } from './browserSealedChannel.ts';

/**
 * The one object the cockpit and every plugin use to talk over a sealed tunnel.
 *
 * Two things make this worth having rather than each caller reaching for the
 * channel directly. First, ordering: sealing advances a nonce counter and
 * opening enforces that it strictly increases, so both directions are pushed
 * through a serial queue and overlapping calls can never reorder into a
 * self-inflicted replay. Second, reach: a plugin that calls `fetch` itself
 * sends plaintext to whoever is relaying the tunnel, and the host cannot stop
 * it. Giving every caller one obvious helper is the only enforcement available.
 *
 * When no channel is established every method is a pass-through, so the same
 * code runs unchanged on the loopback listener where there is nothing to seal.
 */

const JSON_CONTENT_TYPE = 'application/json';

export interface SealedTransport {
  /** False on loopback and before the handshake completes, where everything passes through. */
  active(): boolean;
  sealText(text: string): Promise<string>;
  /** Undefined when the message could not be opened; `lastFailure` says why. */
  openText(text: string): Promise<string | undefined>;
  sealBinary(bytes: Uint8Array): Promise<Uint8Array>;
  openBinary(bytes: Uint8Array): Promise<Uint8Array | undefined>;
  /** Drop-in for `fetch`, sealing the request body and opening the response. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  lastFailure(): string | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createSealedTransport(): SealedTransport & {
  /** Completes the handshake against the host key from the QR. */
  connect: (hostPublicKey: string) => Promise<string | undefined>;
  /** Drops the channel, so everything falls back to pass-through. */
  reset: () => void;
} {
  let channel: SealedChannel | undefined;
  let failure: string | undefined;
  const outbound = createSerialQueue();
  const inbound = createSerialQueue();

  const note = (reason: SealedFailure): undefined => {
    // A decryption failure otherwise shows up as a blank page with no cause, so
    // every one of them names itself.
    failure = describeSealedFailure(reason);
    return undefined;
  };

  const sealBytes = async (bytes: Uint8Array): Promise<string | undefined> => {
    if (channel === undefined) return undefined;
    const sealed = await channel.seal(bytes);
    if (!sealed.ok) return note(sealed.failure);
    return JSON.stringify(sealed.envelope);
  };

  const openBytes = async (text: string): Promise<Uint8Array | undefined> => {
    if (channel === undefined) return undefined;
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return note('malformed');
    }
    const opened = await channel.open(envelope);
    if (!opened.ok) return note(opened.failure);
    return opened.plaintext;
  };

  return {
    active: () => channel !== undefined,
    lastFailure: () => failure,

    async connect(hostPublicKey) {
      const connected = await connectSealedChannel(hostPublicKey);
      if (connected === undefined) {
        failure = 'This browser could not establish a sealed channel.';
        return undefined;
      }
      channel = connected.channel;
      failure = undefined;
      return connected.clientPublicKey;
    },

    reset() {
      channel = undefined;
      failure = undefined;
    },

    async sealText(text) {
      if (channel === undefined) return text;
      return await outbound.run(async () => (await sealBytes(encoder.encode(text))) ?? text);
    },

    async openText(text) {
      if (channel === undefined) return text;
      return await inbound.run(async () => {
        const opened = await openBytes(text);
        return opened === undefined ? undefined : decoder.decode(opened);
      });
    },

    async sealBinary(bytes) {
      if (channel === undefined) return bytes;
      return await outbound.run(async () => {
        const sealed = await sealBytes(bytes);
        return sealed === undefined ? bytes : encoder.encode(sealed);
      });
    },

    async openBinary(bytes) {
      if (channel === undefined) return bytes;
      return await inbound.run(async () => await openBytes(decoder.decode(bytes)));
    },

    async fetch(input, init) {
      if (channel === undefined) return await fetch(input, init);
      const headers = new Headers(init?.headers);
      let body = init?.body;
      if (typeof body === 'string') {
        const sealed = await outbound.run(async () => await sealBytes(encoder.encode(body as string)));
        if (sealed !== undefined) {
          body = sealed;
          // Named in a header rather than guessed at from the shape, so a
          // handler never has to decide whether a body is an envelope.
          headers.set(SEALED_BODY_HEADER, '1');
          headers.set('Content-Type', JSON_CONTENT_TYPE);
        }
      }
      const response = await fetch(input, { ...init, headers, ...(body === undefined ? {} : { body }) });
      if (response.headers.get(SEALED_BODY_HEADER) !== '1') return response;
      const opened = await inbound.run(async () => await openBytes(await response.text()));
      if (opened === undefined) {
        return new Response(JSON.stringify({ error: failure }), { status: 502, headers: response.headers });
      }
      return new Response(opened, { status: response.status, headers: response.headers });
    },
  };
}

/**
 * The page's one sealed channel.
 *
 * A module singleton rather than an instance per caller, because the cockpit
 * and every plugin are bundled into the same page and all of them must share
 * one pair of nonce counters. Two transports over one handshake would each
 * start counting at zero and the receiver would reject the second as a replay.
 *
 * Inactive until a handshake completes, and inactive forever on the loopback
 * listener, so `sealedTransport.fetch` is a plain `fetch` there.
 */
export const sealedTransport = createSealedTransport();
