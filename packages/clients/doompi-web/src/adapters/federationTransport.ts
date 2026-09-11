import { randomBytes } from 'node:crypto';
import { createClientHandshake, createHostHandshake, type SealedChannel } from '@agimon-ai/doompi-web-security/node';
import {
  FEDERATION_HANDSHAKE_TTL_MS,
  FEDERATION_MAX_BODY_BYTES,
  FEDERATION_PROTOCOL_ROUTE,
  FEDERATION_TRANSPORT_ROUTE,
  FEDERATION_TRANSPORT_VERSION,
  createFederationChallenge,
  federationCanonical,
  federationChallengePayload,
  federationHandshakeRequestPayload,
  federationHandshakeResponsePayload,
  federationIdentity,
  parseFederationChallengeResponse,
  parseFederationHandshakeRequest,
  parseFederationHandshakeResponse,
  parseFederationSealedMessage,
  verifyFederationSignature,
  type FederationChallengeResponse,
  type FederationHandshakeRequest,
  type FederationHandshakeResponse,
  type FederationSealedMessage,
} from '../services/federationPolicy.ts';
import { projectAgentCatalog } from '../services/agentCatalog.ts';
import type { FederationPeer } from '../types/agentCatalog.ts';
import type { SessionRecord } from '../types/registry.ts';
import type { FederationStore } from './federationStore.ts';

export const MAX_RESPONSE_BYTES = FEDERATION_MAX_BODY_BYTES;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_PENDING_REQUESTS = 32;
const MAX_SEEN_CHALLENGES = 256;
const REQUEST_TIMEOUT_MS = 10_000;
const PROTOCOL_LIFETIME_MS = 60 * 60 * 1000;

class FederationQueueFullError extends Error {
  constructor() {
    super('Federation request queue is full.');
    this.name = 'FederationQueueFullError';
  }
}

class FederationRequestCancelledError extends Error {
  constructor() {
    super('Federation request was cancelled.');
    this.name = 'FederationRequestCancelledError';
  }
}

function cancellationError(): FederationRequestCancelledError {
  return new FederationRequestCancelledError();
}

export interface FederationSealedStream {
  assertActive(): void;
  open(envelope: unknown): Uint8Array;
  seal(bytes: Uint8Array): unknown;
  close(): void;
}

function sealedStream(channel: SealedChannel, assertActive: () => void, close: () => void): FederationSealedStream {
  return {
    assertActive,
    open(envelope) {
      assertActive();
      const result = channel.open(envelope);
      if (!result.ok || result.plaintext.byteLength > FEDERATION_MAX_BODY_BYTES / 2)
        throw new Error('Federation protocol frame refused.');
      return result.plaintext;
    },
    seal(bytes) {
      assertActive();
      if (bytes.byteLength > FEDERATION_MAX_BODY_BYTES / 2) throw new Error('Federation protocol frame too large.');
      const result = channel.seal(bytes);
      if (!result.ok) throw new Error('Federation protocol channel exhausted.');
      return result.envelope;
    },
    close,
  };
}

export interface FederationProtocolAdmission {
  peer: FederationPeer;
  stream: FederationSealedStream;
  assertAgent(agentId: string): void;
}

/** Serialize sealing and response consumption so HTTP responses cannot overtake their nonces. */
function requestQueue() {
  let settled = Promise.resolve();
  let pending = 0;
  return <T>(operation: () => Promise<T>, signal?: AbortSignal, onCancelled?: () => void): Promise<T> => {
    if (signal?.aborted) {
      onCancelled?.();
      return Promise.reject(cancellationError());
    }
    if (pending >= MAX_PENDING_REQUESTS) return Promise.reject(new FederationQueueFullError());
    pending += 1;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      onCancelled?.();
    };
    const queued = settled
      .then(() => {
        if (signal?.aborted) {
          cancel();
          throw cancellationError();
        }
        return operation();
      })
      .finally(() => {
        pending -= 1;
      });
    settled = queued.then(
      () => undefined,
      () => undefined,
    );
    if (signal === undefined) return queued;

    let removeAbortListener: (() => void) | undefined;
    const result = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cancel();
        reject(cancellationError());
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      queued.then(resolve, reject);
    });
    return result.finally(() => removeAbortListener?.());
  };
}

type FederationCommand =
  | { type: 'catalog' }
  | { type: 'disconnect' }
  | { type: 'attach'; agentId: string; payload: unknown }
  | { type: 'call'; agentId: string; payload: unknown }
  | { type: 'publish'; agentId: string; payload: unknown };

export interface FederationCommandContext {
  peer: FederationPeer;
  agentId: string;
  signal?: AbortSignal;
}

export interface FederationTransportOptions {
  store: FederationStore;
  records(): readonly SessionRecord[];
  onAttach?: (payload: unknown, context: FederationCommandContext) => Promise<unknown>;
  onCall?: (payload: unknown, context: FederationCommandContext) => Promise<unknown>;
  onPublish?: (payload: unknown, context: FederationCommandContext) => Promise<unknown>;
  onNotice?: (message: string) => void;
}

export interface FederationTransportResult {
  status: number;
  body: Record<string, unknown>;
}

export interface FederationTransport {
  handle(value: unknown, now?: number, signal?: AbortSignal): Promise<FederationTransportResult>;
  promote(value: unknown, onClose: () => void): Promise<FederationProtocolAdmission>;
  closePeer(hubId: string): void;
  close(): void;
}

interface ActivePeerSession {
  readonly sessionId: string;
  readonly peerHubId: string;
  readonly peerFingerprint: string;
  readonly localFingerprint: string;
  readonly agentIds: readonly string[];
  readonly origin: string;
  readonly enqueue: ReturnType<typeof requestQueue>;
  readonly channel: SealedChannel;
  expiresAt: number;
  onClose?: () => void;
  promoted?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function grantsMatch(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((id) => expected.has(id));
}

function sessionId(): string {
  return randomBytes(32).toString('base64url');
}

function errorResult(status: number, error: string): FederationTransportResult {
  return { status, body: { error } };
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel('Federation response exceeds its size limit.');
    throw new Error('Federation response exceeds its size limit.');
  }
  if (!response.body) throw new Error('Federation response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel('Federation response exceeds its size limit.');
        throw new Error('Federation response exceeds its size limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function commandOf(value: unknown): FederationCommand | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'catalog' || value.type === 'disconnect') return { type: value.type };
  if (
    (value.type === 'attach' || value.type === 'call' || value.type === 'publish') &&
    typeof value.agentId === 'string' &&
    value.agentId.length > 0 &&
    value.agentId.length <= 128 &&
    'payload' in value
  ) {
    return { type: value.type, agentId: value.agentId, payload: value.payload };
  }
  return undefined;
}

/**
 * Authenticates one enrolled hub at a time. A signed, per-transport epoch binds
 * every one-use hello to this server lifetime, even when replay memory is lost.
 * All agent operations use the sealed channel and recheck the store on every message.
 */
export function createFederationTransport(options: FederationTransportOptions): FederationTransport {
  const sessions = new Map<string, ActivePeerSession>();
  const seenChallenges = new Map<string, number>();
  // Never persist this value: restarting the transport must invalidate captured hellos.
  const serverEpoch = createFederationChallenge();
  let closed = false;
  const notify = (message: string): void => {
    try {
      options.onNotice?.(message);
    } catch {
      // Diagnostics must not prevent terminal cleanup.
    }
  };

  const drop = (id: string): void => {
    const session = sessions.get(id);
    if (session === undefined) return;
    sessions.delete(id);
    try {
      session.onClose?.();
    } catch (error) {
      notify(`federation peer cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const prune = (now: number): void => {
    for (const [challenge, expiresAt] of seenChallenges) if (expiresAt <= now) seenChallenges.delete(challenge);
    for (const [id, session] of sessions) if (session.expiresAt <= now) drop(id);
  };

  const validSession = (session: ActivePeerSession): FederationPeer | undefined => {
    if (
      closed ||
      sessions.get(session.sessionId) !== session ||
      options.store.identity().fingerprint !== session.localFingerprint
    )
      return undefined;
    const peer = options.store.peer(session.peerHubId);
    if (
      peer === undefined ||
      peer.fingerprint !== session.peerFingerprint ||
      peer.origin !== session.origin ||
      !grantsMatch(session.agentIds, peer.agentIds)
    ) {
      return undefined;
    }
    return peer;
  };

  const welcome = (request: FederationHandshakeRequest, now: number): FederationTransportResult => {
    const own = options.store.identity();
    if (request.serverHubId !== own.hubId) return errorResult(404, 'Unknown federation hub.');
    if (request.serverEpoch !== serverEpoch) return errorResult(401, 'The federation server challenge is stale.');
    const peer = options.store.peer(request.clientHubId);
    if (peer === undefined || peer.publicKey !== request.clientPublicKey)
      return errorResult(401, 'Peer is not enrolled.');
    if (!verifyFederationSignature(peer, federationHandshakeRequestPayload(request), request.signature)) {
      return errorResult(401, 'The federation handshake signature was refused.');
    }
    const challengeKey = `${peer.hubId}:${request.challenge}`;
    if (seenChallenges.has(challengeKey)) return errorResult(409, 'The federation handshake challenge was replayed.');
    if ([...sessions.values()].filter((session) => session.peerHubId === peer.hubId).length >= 8) {
      return errorResult(429, 'This peer has reached its connection limit.');
    }
    if (sessions.size >= MAX_ACTIVE_SESSIONS || seenChallenges.size >= MAX_SEEN_CHALLENGES) {
      return errorResult(503, 'Federation is at its peer session limit.');
    }

    const handshake = createHostHandshake();
    const channel = handshake.accept(request.clientEphemeralKey);
    if (channel === undefined) return errorResult(400, 'The federation key exchange was refused.');
    const expiresAt = now + FEDERATION_HANDSHAKE_TTL_MS;
    const responseWithoutSignature: Omit<FederationHandshakeResponse, 'signature'> = {
      v: FEDERATION_TRANSPORT_VERSION,
      type: 'welcome',
      serverHubId: own.hubId,
      clientHubId: peer.hubId,
      serverPublicKey: own.publicKey,
      serverEphemeralKey: handshake.publicKey,
      challenge: request.challenge,
      serverEpoch,
      expiresAt,
      sessionId: sessionId(),
    };
    const response: FederationHandshakeResponse = {
      ...responseWithoutSignature,
      signature: options.store.sign(federationCanonical(federationHandshakeResponsePayload(responseWithoutSignature))),
    };
    seenChallenges.set(challengeKey, request.expiresAt);
    sessions.set(response.sessionId, {
      sessionId: response.sessionId,
      peerHubId: peer.hubId,
      peerFingerprint: peer.fingerprint,
      localFingerprint: own.fingerprint,
      agentIds: [...peer.agentIds],
      channel,
      origin: peer.origin,
      enqueue: requestQueue(),
      expiresAt,
    });
    return { status: 200, body: { ...response } };
  };

  const message = async (
    raw: FederationSealedMessage,
    clock: () => number,
    signal?: AbortSignal,
  ): Promise<FederationTransportResult> => {
    const now = clock();
    const session = sessions.get(raw.sessionId);
    if (session === undefined || session.promoted)
      return errorResult(401, 'The federation HTTP session is not active.');
    if (signal?.aborted) {
      drop(raw.sessionId);
      return errorResult(499, 'The federation request was cancelled.');
    }
    const peer = validSession(session);
    if (peer === undefined || session.expiresAt <= now) {
      drop(raw.sessionId);
      return errorResult(401, 'The federation grants or key changed.');
    }
    const opened = session.channel.open(raw.envelope);
    if (!opened.ok) {
      // Unauthenticated replay or forged ciphertext must not evict the legitimate peer.
      return errorResult(400, `The federation message was refused: ${opened.failure}.`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(opened.plaintext));
    } catch {
      return errorResult(400, 'The federation message was malformed.');
    }
    const command = commandOf(decoded);
    if (command === undefined) return errorResult(400, 'The federation command was invalid.');
    let result: unknown;
    try {
      if (command.type === 'disconnect') {
        result = null;
      } else if (command.type === 'catalog') {
        result = projectAgentCatalog(options.store.identity().hubId, options.records(), peer.agentIds);
      } else {
        if (
          !peer.agentIds.includes(command.agentId) ||
          !options.records().some((record) => record.id === command.agentId)
        ) {
          return errorResult(403, 'That agent is not granted to this peer.');
        }
        const context = {
          peer,
          agentId: command.agentId,
          ...(signal === undefined ? {} : { signal }),
        } satisfies FederationCommandContext;
        if (command.type === 'attach') {
          if (options.onAttach === undefined) return errorResult(404, 'Peer attach is unavailable.');
          result = await options.onAttach(command.payload, context);
        } else if (command.type === 'call') {
          if (options.onCall === undefined) return errorResult(404, 'Peer calls are unavailable.');
          result = await options.onCall(command.payload, context);
        } else {
          if (options.onPublish === undefined) return errorResult(404, 'Peer publication is unavailable.');
          result = await options.onPublish(command.payload, context);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        drop(raw.sessionId);
        return errorResult(499, 'The federation request was cancelled.');
      }
      notify(`federation peer ${peer.hubId} request failed: ${error instanceof Error ? error.message : String(error)}`);
      return errorResult(502, 'The federation peer operation failed.');
    }
    if (signal?.aborted) {
      drop(raw.sessionId);
      return errorResult(499, 'The federation request was cancelled.');
    }
    if (validSession(session) === undefined || session.expiresAt <= clock()) {
      drop(raw.sessionId);
      return errorResult(401, 'The federation grants, key or connection changed during the operation.');
    }
    const serialized = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(serialized) > Math.floor(MAX_RESPONSE_BYTES / 2))
      return errorResult(502, 'Federation result exceeds its size limit.');
    const sealed = session.channel.seal(new TextEncoder().encode(serialized));
    if (!sealed.ok) {
      drop(raw.sessionId);
      return errorResult(503, 'The federation channel is exhausted.');
    }
    if (signal?.aborted) {
      drop(raw.sessionId);
      return errorResult(499, 'The federation request was cancelled.');
    }
    if (command.type === 'disconnect') drop(raw.sessionId);
    return {
      status: 200,
      body: { v: FEDERATION_TRANSPORT_VERSION, type: 'message', sessionId: raw.sessionId, envelope: sealed.envelope },
    };
  };

  return {
    async promote(value, onClose) {
      const raw = parseFederationSealedMessage(value);
      const session = sessions.get(raw.sessionId);
      if (!session) throw new Error('Federation session is not active.');
      try {
        return await session.enqueue(async () => {
          const peer = validSession(session);
          if (!peer || session.expiresAt <= Date.now()) {
            drop(session.sessionId);
            throw new Error('Federation session is not available for protocol promotion.');
          }
          if (session.promoted) throw new Error('Federation session is already promoted.');
          const opened = session.channel.open(raw.envelope);
          if (!opened.ok || new TextDecoder().decode(opened.plaintext) !== '{"type":"protocol"}') {
            drop(session.sessionId);
            throw new Error('Federation protocol proof refused.');
          }
          session.promoted = true;
          session.expiresAt = Date.now() + PROTOCOL_LIFETIME_MS;
          session.onClose = onClose;
          const assertActive = () => {
            if (!validSession(session) || session.expiresAt <= Date.now()) {
              drop(session.sessionId);
              throw new Error('Federation protocol authorization expired or changed.');
            }
          };
          return {
            peer,
            stream: sealedStream(session.channel, assertActive, () => drop(session.sessionId)),
            assertAgent(agentId: string) {
              assertActive();
              if (!session.agentIds.includes(agentId) || !options.records().some((record) => record.id === agentId))
                throw new Error('Agent is not granted to this peer.');
            },
          };
        });
      } catch (error) {
        if (!session.promoted) drop(session.sessionId);
        throw error;
      }
    },
    async handle(value, now = Date.now(), signal) {
      if (closed) return errorResult(503, 'Federation transport is closed.');
      if (signal?.aborted) return errorResult(499, 'The federation request was cancelled.');
      const started = performance.now();
      const clock = () => now + (performance.now() - started);
      prune(now);
      const raw = isRecord(value) ? value : undefined;
      if (raw?.type === 'challenge' && raw.v === FEDERATION_TRANSPORT_VERSION) {
        const own = options.store.identity();
        const challenge: Omit<FederationChallengeResponse, 'signature'> = {
          v: FEDERATION_TRANSPORT_VERSION,
          type: 'challenge',
          serverHubId: own.hubId,
          serverPublicKey: own.publicKey,
          serverEpoch,
        };
        return {
          status: 200,
          body: {
            ...challenge,
            signature: options.store.sign(federationCanonical(federationChallengePayload(challenge))),
          },
        };
      }
      if (raw?.type === 'hello') {
        try {
          return welcome(parseFederationHandshakeRequest(value, now), now);
        } catch {
          return errorResult(400, 'The federation handshake was invalid.');
        }
      }
      try {
        const sealed = parseFederationSealedMessage(value);
        const session = sessions.get(sealed.sessionId);
        if (!session) return errorResult(401, 'The federation session is not active.');
        return await session.enqueue(
          () => message(sealed, clock, signal),
          signal,
          () => drop(session.sessionId),
        );
      } catch (error) {
        if (error instanceof FederationQueueFullError) return errorResult(429, error.message);
        if (error instanceof FederationRequestCancelledError) return errorResult(499, error.message);
        return errorResult(400, 'The federation message was invalid.');
      }
    },
    closePeer(hubId) {
      for (const [id, session] of sessions) if (session.peerHubId === hubId) drop(id);
    },
    close() {
      closed = true;
      for (const id of sessions.keys()) drop(id);
      seenChallenges.clear();
    },
  };
}

export interface FederationPeerClient {
  readonly peer: FederationPeer;
  readonly sessionId: string;
  catalog(): Promise<unknown>;
  disconnect(): Promise<void>;
  promote(): Promise<{ hello: FederationSealedMessage; stream: FederationSealedStream }>;
  attach(agentId: string, payload: unknown): Promise<unknown>;
  call(agentId: string, payload: unknown): Promise<unknown>;
  publish(agentId: string, payload: unknown): Promise<unknown>;
  close(): void;
}

export async function connectFederationPeer(options: {
  store: FederationStore;
  peer: FederationPeer;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<FederationPeerClient> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const own = options.store.identity();
  const ownFingerprint = own.fingerprint;
  const pinnedPeer: FederationPeer = { ...options.peer, agentIds: [...options.peer.agentIds] };
  const assertEnrolled = (): void => {
    const enrolledPeer = options.store.peer(pinnedPeer.hubId);
    if (
      options.store.identity().fingerprint !== ownFingerprint ||
      enrolledPeer === undefined ||
      enrolledPeer.fingerprint !== pinnedPeer.fingerprint ||
      enrolledPeer.origin !== pinnedPeer.origin ||
      !grantsMatch(enrolledPeer.agentIds, pinnedPeer.agentIds)
    ) {
      throw new Error('The federation peer is not currently enrolled with these grants and keys.');
    }
  };
  assertEnrolled();
  const lifetime = new AbortController();
  const post = async (body: unknown): Promise<unknown> => {
    assertEnrolled();
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > FEDERATION_MAX_BODY_BYTES)
      throw new Error('Federation request exceeds its size limit.');
    const signals = [lifetime.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (options.signal !== undefined) signals.splice(1, 0, options.signal);
    const response = await fetcher(new URL(FEDERATION_TRANSPORT_ROUTE, pinnedPeer.origin), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: pinnedPeer.origin },
      redirect: 'error',
      signal: AbortSignal.any(signals),
      body: serialized,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Federation peer request failed (${String(response.status)}).`);
    }
    const result = await readJson(response);
    assertEnrolled();
    return result;
  };
  let welcome: FederationHandshakeResponse;
  let channel: SealedChannel;
  try {
    const serverChallenge = parseFederationChallengeResponse(
      await post({ v: FEDERATION_TRANSPORT_VERSION, type: 'challenge' }),
    );
    if (
      serverChallenge.serverHubId !== pinnedPeer.hubId ||
      serverChallenge.serverPublicKey !== pinnedPeer.publicKey ||
      !verifyFederationSignature(pinnedPeer, federationChallengePayload(serverChallenge), serverChallenge.signature)
    ) {
      throw new Error('The federation server challenge identity or signature did not match the pinned peer.');
    }
    const handshake = createClientHandshake();
    const challenge = createFederationChallenge();
    const expiresAt = now() + FEDERATION_HANDSHAKE_TTL_MS;
    const helloWithoutSignature: Omit<FederationHandshakeRequest, 'signature'> = {
      v: FEDERATION_TRANSPORT_VERSION,
      type: 'hello',
      serverHubId: pinnedPeer.hubId,
      clientHubId: own.hubId,
      clientPublicKey: own.publicKey,
      clientEphemeralKey: handshake.publicKey,
      challenge,
      serverEpoch: serverChallenge.serverEpoch,
      expiresAt,
    };
    const hello: FederationHandshakeRequest = {
      ...helloWithoutSignature,
      signature: options.store.sign(federationCanonical(federationHandshakeRequestPayload(helloWithoutSignature))),
    };
    const responseBody = await post(hello);
    welcome = parseFederationHandshakeResponse(responseBody, now());
    const server = federationIdentity(welcome.serverHubId, welcome.serverPublicKey);
    if (
      welcome.challenge !== challenge ||
      welcome.serverEpoch !== serverChallenge.serverEpoch ||
      welcome.serverHubId !== pinnedPeer.hubId ||
      welcome.clientHubId !== own.hubId ||
      server.fingerprint !== pinnedPeer.fingerprint ||
      !verifyFederationSignature(server, federationHandshakeResponsePayload(welcome), welcome.signature)
    ) {
      throw new Error('The federation server identity or signature did not match the pinned peer.');
    }
    const accepted = handshake.accept(welcome.serverEphemeralKey);
    if (accepted === undefined) throw new Error('The federation key exchange was refused.');
    channel = accepted;
  } catch (error) {
    lifetime.abort(error);
    throw error;
  }
  let closed = false;
  let promoted = false;
  const enqueue = requestQueue();
  const send = async (command: FederationCommand): Promise<unknown> => {
    if (closed || promoted || lifetime.signal.aborted || now() >= welcome.expiresAt)
      throw new Error('The federation peer connection is closed or expired.');
    const currentOwn = options.store.identity();
    const currentPeer = options.store.peer(pinnedPeer.hubId);
    if (
      currentOwn.fingerprint !== ownFingerprint ||
      currentPeer === undefined ||
      currentPeer.fingerprint !== pinnedPeer.fingerprint ||
      currentPeer.origin !== pinnedPeer.origin ||
      !grantsMatch(currentPeer.agentIds, pinnedPeer.agentIds)
    ) {
      closed = true;
      throw new Error('The federation peer grant or key changed.');
    }
    // Our grants describe access HERE. The remote hub alone authorizes its own agent IDs.
    const sealed = channel.seal(new TextEncoder().encode(JSON.stringify(command)));
    if (!sealed.ok) {
      closed = true;
      throw new Error(`The federation channel is exhausted: ${sealed.failure}.`);
    }
    const body = await post({
      v: FEDERATION_TRANSPORT_VERSION,
      type: 'message',
      sessionId: welcome.sessionId,
      envelope: sealed.envelope,
    });
    const after = options.store.peer(pinnedPeer.hubId);
    if (
      closed ||
      lifetime.signal.aborted ||
      now() >= welcome.expiresAt ||
      options.store.identity().fingerprint !== ownFingerprint ||
      after === undefined ||
      after.fingerprint !== pinnedPeer.fingerprint ||
      after.origin !== pinnedPeer.origin ||
      !grantsMatch(after.agentIds, pinnedPeer.agentIds)
    ) {
      throw new Error('The federation peer grant, key or connection changed during the request.');
    }
    const message = parseFederationSealedMessage(body);
    if (message.sessionId !== welcome.sessionId) throw new Error('The federation response session did not match.');
    const opened = channel.open(message.envelope);
    if (!opened.ok) {
      closed = true;
      throw new Error(`The federation response was refused: ${opened.failure}.`);
    }
    const decoded: unknown = JSON.parse(new TextDecoder().decode(opened.plaintext));
    if (!isRecord(decoded) || decoded.ok !== true) throw new Error('The federation peer returned an invalid response.');
    return decoded.result;
  };
  const request = (command: FederationCommand): Promise<unknown> =>
    enqueue(async () => {
      try {
        return await send(command);
      } catch (error) {
        closed = true;
        lifetime.abort();
        throw error;
      }
    });
  return {
    peer: { ...pinnedPeer, agentIds: [...pinnedPeer.agentIds] },
    sessionId: welcome.sessionId,
    catalog: () => request({ type: 'catalog' }),
    disconnect: async () => {
      try {
        await request({ type: 'disconnect' });
      } finally {
        closed = true;
        lifetime.abort();
      }
    },
    promote: () =>
      enqueue(async () => {
        assertEnrolled();
        if (closed || promoted || now() >= welcome.expiresAt) throw new Error('Federation session cannot be promoted.');
        const sealed = channel.seal(new TextEncoder().encode('{"type":"protocol"}'));
        if (!sealed.ok) throw new Error('Federation protocol proof could not be sealed.');
        promoted = true;
        const expiresAt = now() + PROTOCOL_LIFETIME_MS;
        return {
          hello: {
            v: FEDERATION_TRANSPORT_VERSION,
            type: 'message',
            sessionId: welcome.sessionId,
            envelope: sealed.envelope,
          },
          stream: sealedStream(
            channel,
            () => {
              assertEnrolled();
              if (closed || now() >= expiresAt) throw new Error('Federation protocol connection closed or expired.');
            },
            () => {
              closed = true;
              lifetime.abort();
            },
          ),
        };
      }),
    attach: (agentId, payload) => request({ type: 'attach', agentId, payload }),
    call: (agentId, payload) => request({ type: 'call', agentId, payload }),
    publish: (agentId, payload) => request({ type: 'publish', agentId, payload }),
    close: () => {
      closed = true;
      lifetime.abort();
    },
  };
}

export { FEDERATION_PROTOCOL_ROUTE, FEDERATION_TRANSPORT_ROUTE };
