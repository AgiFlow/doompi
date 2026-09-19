import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DoomSessionCommunicationEndpoint } from '@agimon-ai/doompi-core/hub-channel';

const PEER_CONFIG_VERSION = 1;
const PEER_CONFIG_FILE = 'peers.json';
const PEER_ROUTE = '/api/plugins/session-peer/inbox';
const PEER_HEADER = 'x-doompi-session-peer';
const TIMESTAMP_HEADER = 'x-doompi-session-timestamp';
const SIGNATURE_HEADER = 'x-doompi-session-signature';
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface SessionPeer {
  readonly hostId: string;
  readonly url: string;
  readonly secret: string;
  /** Explicit remote targets this peer may deliver to. Empty means no delivery grant. */
  readonly allowedSessionIds: readonly string[];
}

export interface SessionPeerConfig {
  readonly version: typeof PEER_CONFIG_VERSION;
  readonly hostId: string;
  readonly peers: readonly SessionPeer[];
}

export interface RemoteSessionReference {
  readonly hostId: string;
  readonly sessionId: string;
}

export interface SessionPeerEnvelope {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly type: string;
  readonly payload: unknown;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function peerOf(value: unknown): SessionPeer | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!validId(record.hostId) || typeof record.url !== 'string' || typeof record.secret !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return undefined;
  const allowedSessionIds =
    Array.isArray(record.allowedSessionIds) && record.allowedSessionIds.every(validId)
      ? record.allowedSessionIds
      : undefined;
  if (allowedSessionIds === undefined || record.secret.length < 32) return undefined;
  return { hostId: record.hostId, url: url.toString(), secret: record.secret, allowedSessionIds };
}

export function sessionPeerConfigPath(homeDirectory: string): string {
  return path.join(homeDirectory, '.pi', '.doom', 'session', PEER_CONFIG_FILE);
}

/** Reads operator-provisioned peers. Invalid or unreadable config fails closed. */
export function readSessionPeerConfig(homeDirectory: string): SessionPeerConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionPeerConfigPath(homeDirectory), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== PEER_CONFIG_VERSION || !validId(record.hostId) || !Array.isArray(record.peers))
    return undefined;
  const peers = record.peers.map(peerOf);
  if (peers.some((peer) => peer === undefined)) return undefined;
  const resolved = peers as SessionPeer[];
  if (
    new Set(resolved.map((peer) => peer.hostId)).size !== resolved.length ||
    resolved.some((peer) => peer.hostId === record.hostId)
  )
    return undefined;
  return { version: PEER_CONFIG_VERSION, hostId: record.hostId, peers: resolved };
}

/** `peer/<host-id>/<session-id>` is the only remote target spelling. */
export function parseRemoteSessionReference(value: string): RemoteSessionReference | undefined {
  const match = /^peer\/([^/]+)\/([^/]+)$/u.exec(value);
  return match && validId(match[1]) && validId(match[2]) ? { hostId: match[1], sessionId: match[2] } : undefined;
}

export function peerSessionReference(hostId: string, sessionId: string): string {
  if (!validId(hostId) || !validId(sessionId))
    throw new TypeError('Remote host and session identifiers must be safe opaque IDs.');
  return `peer/${hostId}/${sessionId}`;
}

function signature(secret: string, method: string, pathname: string, timestamp: string, body: string): string {
  const digest = createHash('sha256').update(body).digest('base64url');
  return createHmac('sha256', secret).update(`${method}\n${pathname}\n${timestamp}\n${digest}`).digest('base64url');
}

export function peerRequestHeaders(
  sourceHostId: string,
  peer: SessionPeer,
  method: string,
  pathname: string,
  body: string,
  now = Date.now(),
): Headers {
  if (!validId(sourceHostId)) throw new TypeError('Source host identity must be a safe opaque ID.');
  const timestamp = String(now);
  return new Headers({
    'content-type': 'application/json',
    [PEER_HEADER]: sourceHostId,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature(peer.secret, method, pathname, timestamp, body),
  });
}

export function verifyPeerRequest(
  config: SessionPeerConfig,
  request: Request,
  body: string,
  now = Date.now(),
): SessionPeer | undefined {
  const hostId = request.headers.get(PEER_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const supplied = request.headers.get(SIGNATURE_HEADER);
  if (!hostId || !timestamp || !supplied || !/^\d{1,16}$/u.test(timestamp)) return undefined;
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > MAX_CLOCK_SKEW_MS) return undefined;
  const peer = config.peers.find((candidate) => candidate.hostId === hostId);
  if (!peer) return undefined;
  const expected = Buffer.from(signature(peer.secret, request.method, new URL(request.url).pathname, timestamp, body));
  const actual = Buffer.from(supplied);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected) ? peer : undefined;
}

function envelopeOf(value: unknown): SessionPeerEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return validId(record.sourceSessionId) &&
    validId(record.targetSessionId) &&
    typeof record.type === 'string' &&
    record.type !== ''
    ? {
        sourceSessionId: record.sourceSessionId,
        targetSessionId: record.targetSessionId,
        type: record.type,
        payload: record.payload,
      }
    : undefined;
}

export function parseSessionPeerEnvelope(value: unknown): SessionPeerEnvelope | undefined {
  return envelopeOf(value);
}

/** Adds asynchronous tunnel publication to a host-bound local communication endpoint. */
export function createPeerCommunication(options: {
  readonly local: DoomSessionCommunicationEndpoint;
  readonly homeDirectory: string;
  readonly fetch?: typeof fetch;
}): DoomSessionCommunicationEndpoint {
  const config = readSessionPeerConfig(options.homeDirectory);
  const send = options.fetch ?? fetch;
  return {
    sessionId: options.local.sessionId,
    publish(target, type, payload) {
      const remote = parseRemoteSessionReference(target);
      if (!remote) return options.local.publish(target, type, payload);
      const peer = config?.peers.find((candidate) => candidate.hostId === remote.hostId);
      if (!config || !peer) return false;
      const body = JSON.stringify({
        sourceSessionId: options.local.sessionId,
        targetSessionId: remote.sessionId,
        type,
        payload,
      });
      const url = new URL(PEER_ROUTE, peer.url);
      void send(url, {
        method: 'POST',
        headers: peerRequestHeaders(config.hostId, peer, 'POST', '/inbox', body),
        body,
      }).catch(() => undefined);
      return true;
    },
    subscribe: (type, listener) => options.local.subscribe(type, listener),
    onPeerReady: (listener) => options.local.onPeerReady(listener),
    close: () => options.local.close(),
  };
}
