/**
 * Pairing a device, as a state machine over injected randomness and time.
 *
 *   code (120s) --claim--> pending (180s) --approve--> approved --consume--> consumed
 *                             |                 \
 *                             +----- deny -------+--> denied
 *
 * The host approval step is the point. A scanned code proves someone is
 * standing where the screen is, but a screen is visible over a shoulder and in
 * a screenshare, so the code alone is a single factor for a credential that
 * ends in shell access. Approving on the machine is the second.
 *
 * Randomness and hashing arrive as functions so this file stays free of
 * node:crypto and testable with a counter.
 */

import { PAIRING_CODE_TTL_MS, PAIRING_REQUEST_TTL_MS, type PairingStatus } from '../types/remoteAccess.ts';
import { sanitizeEdgeIp, sanitizeUserAgent } from './deviceSessions.ts';

/** Failed claims allowed per source inside one window before the endpoint starts refusing. */
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 60_000;
/** Caps throttle state even if many distinct peers reach the listener. */
const SOURCE_LIMIT = 1024;
/** How long a settled request stays readable, so a late approval is still collectable. */
const PAIRING_REQUEST_RETENTION_MS = PAIRING_REQUEST_TTL_MS * 2;

export interface PairingRequest {
  id: string;
  userAgent: string;
  edgeIp: string;
  createdAt: number;
  status: PairingStatus;
}

export type ClaimOutcome = { ok: true; requestId: string } | { ok: false; code: 'unknown_code' | 'rate_limited' };

export interface PairingFlowOptions {
  /** Returns a fresh high-entropy token; the adapter supplies node:crypto. */
  randomToken: () => string;
  /** One-way digest of a token; only the digest is retained. */
  digest: (token: string) => string;
  now: () => number;
  onNotice?: (message: string) => void;
}

export interface PairingFlow {
  /** Mints the code a QR carries. Replaces any previous one: only the newest is claimable. */
  mintCode(): { code: string; expiresAt: number };
  claim(input: {
    code: string;
    userAgent: string | undefined;
    edgeIp: string | undefined;
    /** Source normalized by the adapter from trusted proxy metadata or the socket peer. */
    sourceAddress: string | undefined;
  }): ClaimOutcome;
  status(requestId: string): PairingStatus | undefined;
  approve(requestId: string): 'approved' | 'unknown' | 'expired' | 'settled';
  deny(requestId: string): 'denied' | 'unknown' | 'settled';
  /** Takes an approved request exactly once, returning what the device record needs. */
  consume(requestId: string): { userAgent: string } | undefined;
  pending(): readonly PairingRequest[];
  /** Drops what has aged out. Only reclaims memory; expiry is derived, not scheduled. */
  sweep(): void;
  clear(): void;
}

export function createPairingFlow(options: PairingFlowOptions): PairingFlow {
  /** Only the newest code is live, so minting a second one retires the first. */
  let liveCode: { hash: string; expiresAt: number } | undefined;
  const requests = new Map<string, PairingRequest>();
  const attemptsBySource = new Map<string, { windowStartedAt: number; failures: number }>();

  const notice = options.onNotice ?? ((): void => {});

  const isExpired = (request: PairingRequest, now: number): boolean =>
    request.status === 'pending' && now - request.createdAt >= PAIRING_REQUEST_TTL_MS;

  /** Derived rather than scheduled, so a stopped clock cannot leave a request live. */
  const statusOf = (request: PairingRequest, now: number): PairingStatus =>
    isExpired(request, now) ? 'expired' : request.status;

  const countFailure = (sourceAddress: string | undefined, now: number): 'ok' | 'rate_limited' => {
    const source = sourceAddress ?? 'unknown';
    let attempts = attemptsBySource.get(source);
    if (attempts === undefined || now - attempts.windowStartedAt >= ATTEMPT_WINDOW_MS) {
      if (attempts === undefined && attemptsBySource.size >= SOURCE_LIMIT) {
        const oldest = attemptsBySource.keys().next().value as string | undefined;
        if (oldest !== undefined) attemptsBySource.delete(oldest);
      }
      attempts = { windowStartedAt: now, failures: 0 };
      attemptsBySource.set(source, attempts);
    }
    attempts.failures += 1;
    if (attempts.failures === ATTEMPT_LIMIT + 1) {
      notice(`pairing claim abuse detected from ${source}; throttling invalid attempts`);
    }
    return attempts.failures > ATTEMPT_LIMIT ? 'rate_limited' : 'ok';
  };

  return {
    mintCode() {
      const code = options.randomToken();
      const expiresAt = options.now() + PAIRING_CODE_TTL_MS;
      liveCode = { hash: options.digest(code), expiresAt };
      return { code, expiresAt };
    },

    claim(input) {
      const now = options.now();
      const presented = options.digest(input.code);
      // The code is single use and dies on the first claim, successful or not,
      // so a leaked one cannot be replayed behind the legitimate scan.
      if (liveCode === undefined || now >= liveCode.expiresAt || liveCode.hash !== presented) {
        const limit = countFailure(input.sourceAddress, now);
        if (limit !== 'ok') return { ok: false, code: limit };
        return { ok: false, code: 'unknown_code' };
      }
      liveCode = undefined;
      const request: PairingRequest = {
        id: options.randomToken(),
        userAgent: sanitizeUserAgent(input.userAgent),
        edgeIp: sanitizeEdgeIp(input.edgeIp),
        createdAt: now,
        status: 'pending',
      };
      requests.set(request.id, request);
      notice(`pairing requested from ${request.userAgent} via ${request.edgeIp}`);
      return { ok: true, requestId: request.id };
    },

    status(requestId) {
      const request = requests.get(requestId);
      return request === undefined ? undefined : statusOf(request, options.now());
    },

    approve(requestId) {
      const request = requests.get(requestId);
      if (request === undefined) return 'unknown';
      const now = options.now();
      if (isExpired(request, now)) return 'expired';
      if (request.status !== 'pending') return 'settled';
      request.status = 'approved';
      notice(`pairing approved for ${request.userAgent}`);
      return 'approved';
    },

    deny(requestId) {
      const request = requests.get(requestId);
      if (request === undefined) return 'unknown';
      if (request.status !== 'pending') return 'settled';
      request.status = 'denied';
      notice(`pairing denied for ${request.userAgent}`);
      return 'denied';
    },

    consume(requestId) {
      const request = requests.get(requestId);
      if (request === undefined || request.status !== 'approved') return undefined;
      // Single use with no grace window. If the response is lost in flight the
      // user rescans, which costs five seconds and removes any question about
      // who else might be holding this id.
      request.status = 'consumed';
      return { userAgent: request.userAgent };
    },

    pending() {
      const now = options.now();
      return [...requests.values()].filter((request) => statusOf(request, now) === 'pending');
    },

    sweep() {
      const now = options.now();
      for (const [id, request] of requests) {
        // A settled request is kept well past its window rather than dropped on
        // sight: an approval landing in the last second still has to be
        // collected by the phone's next poll, and a denied one should read as
        // denied rather than decay into "no such request".
        if (now - request.createdAt >= PAIRING_REQUEST_RETENTION_MS) requests.delete(id);
      }
      if (liveCode !== undefined && now >= liveCode.expiresAt) liveCode = undefined;
      for (const [source, attempts] of attemptsBySource) {
        if (now - attempts.windowStartedAt >= ATTEMPT_WINDOW_MS) attemptsBySource.delete(source);
      }
    },

    clear() {
      requests.clear();
      liveCode = undefined;
      attemptsBySource.clear();
    },
  };
}
