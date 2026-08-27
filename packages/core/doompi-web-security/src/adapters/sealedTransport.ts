import { createSerialQueue } from '../services/serialQueue.ts';
import { describeSealedFailure, type SealedFailure } from '../types/sealedChannel.ts';
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
  /** Drop-in for `fetch`, relaying the complete request through the sealed channel when configured. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  lastFailure(): string | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SealedHttpRequest {
  v: 1;
  method: string;
  target: string;
  headers: Array<[string, string]>;
  body?: string;
}

interface SealedHttpResponse {
  v: 1;
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function bodyBytes(body: RequestInit['body']): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new Error('The sealed HTTP transport does not support this request body type.');
}

function requestTarget(input: string): string {
  if (!input.startsWith('/')) throw new Error('A sealed HTTP request must use a root-relative URL.');
  return input;
}

function isSealedHttpResponse(value: unknown): value is SealedHttpResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SealedHttpResponse>;
  return (
    candidate.v === 1 &&
    typeof candidate.status === 'number' &&
    Array.isArray(candidate.headers) &&
    candidate.headers.every(
      (header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === 'string'),
    ) &&
    typeof candidate.body === 'string'
  );
}
export function createSealedTransport(): SealedTransport & {
  /** Completes the handshake against the host key from the QR. */
  connect: (hostPublicKey: string) => Promise<string | undefined>;
  /** Drops the channel, so everything falls back to pass-through. */
  reset: () => void;
  /** Selects the same-origin endpoint that carries sealed HTTP exchanges. */
  relayRequestsThrough: (path: string) => void;
} {
  let channel: SealedChannel | undefined;
  let failure: string | undefined;
  const outbound = createSerialQueue();
  const inbound = createSerialQueue();
  const exchange = createSerialQueue();
  let relayPath: string | undefined;
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

    relayRequestsThrough(path) {
      relayPath = path;
    },

    reset() {
      channel = undefined;
      failure = undefined;
    },

    async sealText(text) {
      if (channel === undefined) return text;
      return await outbound.run(async () => {
        const sealed = await sealBytes(encoder.encode(text));
        if (sealed === undefined) throw new Error(failure ?? 'The active sealed channel could not encrypt a message.');
        return sealed;
      });
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
        if (sealed === undefined) throw new Error(failure ?? 'The active sealed channel could not encrypt a message.');
        return encoder.encode(sealed);
      });
    },

    async openBinary(bytes) {
      if (channel === undefined) return bytes;
      return await inbound.run(async () => await openBytes(decoder.decode(bytes)));
    },

    async fetch(input, init) {
      const gateway = relayPath;
      if (channel === undefined || gateway === undefined) return await fetch(input, init);
      return await exchange.run(async () => {
        const bytes = await bodyBytes(init?.body);
        const request: SealedHttpRequest = {
          v: 1,
          method: (init?.method ?? 'GET').toUpperCase(),
          target: requestTarget(input),
          headers: Array.from(new Headers(init?.headers).entries()),
          ...(bytes === undefined ? {} : { body: encodeBase64(bytes) }),
        };
        const sealed = await sealBytes(encoder.encode(JSON.stringify(request)));
        if (sealed === undefined) {
          return new Response(JSON.stringify({ error: failure }), { status: 502 });
        }
        const relayResponse = await fetch(gateway, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': JSON_CONTENT_TYPE },
          body: sealed,
        });
        const opened = await openBytes(await relayResponse.text());
        if (opened === undefined) {
          return new Response(JSON.stringify({ error: failure }), { status: 502 });
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(decoder.decode(opened));
        } catch {
          decoded = undefined;
        }
        if (!isSealedHttpResponse(decoded)) {
          failure = 'The sealed HTTP response was malformed.';
          return new Response(JSON.stringify({ error: failure }), { status: 502 });
        }
        const body = decodeBase64(decoded.body);
        return new Response(decoded.status === 204 || decoded.status === 205 || decoded.status === 304 ? null : body, {
          status: decoded.status,
          headers: decoded.headers,
        });
      });
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
