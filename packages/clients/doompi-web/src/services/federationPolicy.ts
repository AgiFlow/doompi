import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { FederationIdentity, FederationPeer } from '../types/agentCatalog.ts';

export const FEDERATION_MAX_PEERS = 64;
export const FEDERATION_MAX_GRANTS = 1024;
export const FEDERATION_TRANSPORT_VERSION = 1;
export const FEDERATION_TRANSPORT_ROUTE = '/api/federation/transport';
export const FEDERATION_PROTOCOL_ROUTE = '/api/federation/protocol';
export const FEDERATION_HANDSHAKE_TTL_MS = 30_000;
export const FEDERATION_MAX_BODY_BYTES = 256 * 1024;
const HUB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ED25519_SPKI_BYTES = 44;
const ED25519_SIGNATURE_BYTES = 64;
const ECDH_PUBLIC_BYTES = 65;
const CHALLENGE_BYTES = 32;
const MAX_SESSION_ID_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface FederationChallengeResponse {
  v: typeof FEDERATION_TRANSPORT_VERSION;
  type: 'challenge';
  serverHubId: string;
  serverPublicKey: string;
  serverEpoch: string;
  signature: string;
}

export interface FederationHandshakeRequest {
  v: typeof FEDERATION_TRANSPORT_VERSION;
  type: 'hello';
  serverHubId: string;
  clientHubId: string;
  clientPublicKey: string;
  clientEphemeralKey: string;
  challenge: string;
  serverEpoch: string;
  expiresAt: number;
  signature: string;
}

export interface FederationHandshakeResponse {
  v: typeof FEDERATION_TRANSPORT_VERSION;
  type: 'welcome';
  serverHubId: string;
  clientHubId: string;
  serverPublicKey: string;
  serverEphemeralKey: string;
  challenge: string;
  serverEpoch: string;
  expiresAt: number;
  sessionId: string;
  signature: string;
}

export interface FederationSealedMessage {
  v: typeof FEDERATION_TRANSPORT_VERSION;
  type: 'message';
  sessionId: string;
  envelope: unknown;
}

function encodedBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil((bytes * 8) / 6) + 4 || !BASE64URL.test(value))
    return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

function boundedExpiry(value: unknown, now: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > now &&
    value <= now + FEDERATION_HANDSHAKE_TTL_MS
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Stable JSON for signatures, with no machine-derived fields added implicitly. */
export function federationCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(federationCanonical).join(',')}]`;
  const record = object(value);
  if (record === undefined) throw new Error('Federation signatures require JSON values.');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${federationCanonical(record[key])}`)
    .join(',')}}`;
}

export function federationIdentity(hubId: unknown, publicKey: unknown): FederationIdentity {
  if (typeof hubId !== 'string' || !HUB_ID.test(hubId)) throw new Error('Invalid federation hub identity.');
  if (!encodedBytes(publicKey, ED25519_SPKI_BYTES)) throw new Error('Invalid federation public key encoding.');
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Federation requires an Ed25519 public key.');
  return {
    hubId,
    publicKey,
    fingerprint: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'),
  };
}

export function verifyFederationSignature(identity: FederationIdentity, payload: unknown, signature: unknown): boolean {
  if (!encodedBytes(signature, ED25519_SIGNATURE_BYTES)) return false;
  try {
    return verify(
      null,
      Buffer.from(federationCanonical(payload), 'utf8'),
      createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), format: 'der', type: 'spki' }),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function createFederationChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString('base64url');
}

export function federationChallengePayload(
  response: Omit<FederationChallengeResponse, 'signature'>,
): Record<string, unknown> {
  return {
    v: response.v,
    type: response.type,
    serverHubId: response.serverHubId,
    serverPublicKey: response.serverPublicKey,
    serverEpoch: response.serverEpoch,
  };
}

export function parseFederationChallengeResponse(value: unknown): FederationChallengeResponse {
  const raw = object(value);
  if (
    raw === undefined ||
    raw.v !== FEDERATION_TRANSPORT_VERSION ||
    raw.type !== 'challenge' ||
    !encodedBytes(raw.serverEpoch, CHALLENGE_BYTES) ||
    !encodedBytes(raw.signature, ED25519_SIGNATURE_BYTES)
  ) {
    throw new Error('Invalid federation server challenge.');
  }
  federationIdentity(raw.serverHubId, raw.serverPublicKey);
  return raw as unknown as FederationChallengeResponse;
}

export function federationHandshakeRequestPayload(
  request: Omit<FederationHandshakeRequest, 'signature'>,
): Record<string, unknown> {
  return {
    v: request.v,
    type: request.type,
    serverHubId: request.serverHubId,
    clientHubId: request.clientHubId,
    clientPublicKey: request.clientPublicKey,
    clientEphemeralKey: request.clientEphemeralKey,
    challenge: request.challenge,
    serverEpoch: request.serverEpoch,
    expiresAt: request.expiresAt,
  };
}

export function federationHandshakeResponsePayload(
  response: Omit<FederationHandshakeResponse, 'signature'>,
): Record<string, unknown> {
  return {
    v: response.v,
    type: response.type,
    serverHubId: response.serverHubId,
    clientHubId: response.clientHubId,
    serverPublicKey: response.serverPublicKey,
    serverEphemeralKey: response.serverEphemeralKey,
    challenge: response.challenge,
    serverEpoch: response.serverEpoch,
    expiresAt: response.expiresAt,
    sessionId: response.sessionId,
  };
}

export function parseFederationHandshakeRequest(value: unknown, now = Date.now()): FederationHandshakeRequest {
  const raw = object(value);
  if (
    raw === undefined ||
    raw.v !== FEDERATION_TRANSPORT_VERSION ||
    raw.type !== 'hello' ||
    typeof raw.serverHubId !== 'string' ||
    typeof raw.clientHubId !== 'string' ||
    typeof raw.clientPublicKey !== 'string' ||
    typeof raw.clientEphemeralKey !== 'string' ||
    typeof raw.challenge !== 'string' ||
    typeof raw.signature !== 'string' ||
    !HUB_ID.test(raw.serverHubId) ||
    !HUB_ID.test(raw.clientHubId) ||
    !encodedBytes(raw.clientPublicKey, ED25519_SPKI_BYTES) ||
    !encodedBytes(raw.clientEphemeralKey, ECDH_PUBLIC_BYTES) ||
    !encodedBytes(raw.challenge, CHALLENGE_BYTES) ||
    !encodedBytes(raw.serverEpoch, CHALLENGE_BYTES) ||
    !boundedExpiry(raw.expiresAt, now) ||
    !encodedBytes(raw.signature, ED25519_SIGNATURE_BYTES)
  ) {
    throw new Error('Invalid federation handshake request.');
  }
  federationIdentity(raw.clientHubId, raw.clientPublicKey);
  return raw as unknown as FederationHandshakeRequest;
}

export function parseFederationHandshakeResponse(value: unknown, now = Date.now()): FederationHandshakeResponse {
  const raw = object(value);
  if (
    raw === undefined ||
    raw.v !== FEDERATION_TRANSPORT_VERSION ||
    raw.type !== 'welcome' ||
    typeof raw.serverHubId !== 'string' ||
    typeof raw.clientHubId !== 'string' ||
    typeof raw.serverPublicKey !== 'string' ||
    typeof raw.serverEphemeralKey !== 'string' ||
    typeof raw.challenge !== 'string' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.signature !== 'string' ||
    !HUB_ID.test(raw.serverHubId) ||
    !HUB_ID.test(raw.clientHubId) ||
    !encodedBytes(raw.serverPublicKey, ED25519_SPKI_BYTES) ||
    !encodedBytes(raw.serverEphemeralKey, ECDH_PUBLIC_BYTES) ||
    !encodedBytes(raw.challenge, CHALLENGE_BYTES) ||
    !encodedBytes(raw.serverEpoch, CHALLENGE_BYTES) ||
    !encodedBytes(raw.sessionId, MAX_SESSION_ID_BYTES) ||
    !boundedExpiry(raw.expiresAt, now) ||
    !encodedBytes(raw.signature, ED25519_SIGNATURE_BYTES)
  ) {
    throw new Error('Invalid federation handshake response.');
  }
  federationIdentity(raw.serverHubId, raw.serverPublicKey);
  return raw as unknown as FederationHandshakeResponse;
}

export function parseFederationSealedMessage(value: unknown): FederationSealedMessage {
  const raw = object(value);
  if (
    raw === undefined ||
    raw.v !== FEDERATION_TRANSPORT_VERSION ||
    raw.type !== 'message' ||
    !encodedBytes(raw.sessionId, MAX_SESSION_ID_BYTES) ||
    raw.envelope === undefined
  ) {
    throw new Error('Invalid federation sealed message.');
  }
  return raw as unknown as FederationSealedMessage;
}

export function parseFederationPeer(value: unknown): FederationPeer {
  const raw = object(value);
  if (raw === undefined) throw new Error('Expected a peer object.');
  const identity = federationIdentity(raw.hubId, raw.publicKey);
  if (raw.fingerprint !== identity.fingerprint) throw new Error('Confirm the peer public-key fingerprint.');
  if (
    typeof raw.name !== 'string' ||
    raw.name.trim().length === 0 ||
    raw.name.length > 128 ||
    Array.from(raw.name).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new Error('Peer name must contain 1 to 128 printable characters.');
  }
  if (typeof raw.origin !== 'string' || raw.origin.length > 2048) throw new Error('Invalid peer origin.');
  const origin = new URL(raw.origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    ![origin.origin, `${origin.origin}/`].includes(raw.origin)
  )
    throw new Error('Peer origin must be HTTPS (HTTP is allowed only for loopback), without credentials or a path.');
  if (
    !Array.isArray(raw.agentIds) ||
    raw.agentIds.length > FEDERATION_MAX_GRANTS ||
    !raw.agentIds.every((id): id is string => typeof id === 'string' && AGENT_ID.test(id)) ||
    new Set(raw.agentIds).size !== raw.agentIds.length
  ) {
    throw new Error('Provide unique, explicit local agent IDs; wildcard grants are not supported.');
  }
  return { ...identity, name: raw.name.trim(), origin: origin.origin, agentIds: [...raw.agentIds] };
}
