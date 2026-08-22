/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs are detached OS processes. A signal-based interrupt
 * (`process.kill(pid, SIGUSR2|SIGBREAK)`) cannot be delivered cross-process on
 * Windows and throws `ENOSYS`, which would leave async runs uninterruptible
 * (no stop, no live steer) on that platform. This module is a portable,
 * file-based control inbox inside the run directory instead: the parent drops
 * a request file, the runner watches the inbox and routes it into its own
 * interrupt handling, identically on every platform. The OS signal is kept
 * only as an opportunistic fast-path; its failure is non-fatal because the
 * file inbox is authoritative.
 *
 * FIX 1 - steer messages must survive a failed dispatch:
 * The predecessor (`doom-pi-subagents/src/runs/background/control-channel.ts`)
 * deleted a steer request file BEFORE dispatching it. A throw during dispatch
 * then lost the instruction with no trace: the user's steer vanished and
 * nothing on disk or in memory recorded that it had ever arrived. Steer
 * requests here are claimed by rename instead: `claimSteerRequestsFromDir`
 * atomically moves a request out of the queue (deciding a single winner among
 * any concurrent consumers in the same step), the caller dispatches what it
 * claimed, and only `commit()` - called after dispatch returns - deletes it.
 * A dispatch that throws calls `release()`, which renames the file back to
 * its original name so the next scan retries it. This package's own delivery
 * loop (`ControlChannelWatcher.check`) follows exactly this claim -> dispatch
 * -> commit/release shape; see `src/intercom/nativeTeamChannel.ts`'s
 * "deliver, then mark seen" for the same principle applied to team messages.
 *
 * Residual gap: if the process dies between claim and release (not a thrown
 * error, a hard kill), the claimed file is left under its `.claim-<id>` name
 * and no longer matches a normal directory scan. Nothing here sweeps it back.
 * That is a real gap, not an oversight - recovering from a hard process kill
 * needs a second, independent process to notice, which does not exist yet in
 * this package. What this module guarantees is the fix that was asked for and
 * that a live process can retry: a message is never lost to a dispatch that
 * merely throws.
 *
 * FIX 2 - a missing file and a permission failure are different situations:
 * one is the routine "someone else already consumed this" case, harmless and
 * expected; the other means this run's control channel cannot be trusted and
 * must be surfaced, not swallowed. `removeIfPresent` below is the one place
 * this module deletes a control file, and it draws exactly that line: `ENOENT`
 * is absorbed, anything else is rethrown.
 *
 * FIX 3/4 - watch-first, `PollScheduler` as the bounded safety net:
 * `ControlChannelWatcher` registers one subscription per watched run with the
 * shared `PollScheduler` (see its header) instead of owning a `setInterval`,
 * the same "watch-first, poll as a bounded safety net" shape `PollScheduler`
 * was built for: `fs.watch` on the inbox directory calls `wake()` for low
 * latency, and the registered subscription's own `intervalMs` is deliberately
 * loose because it exists only to cover platforms and mount types where
 * watches are unreliable, not to carry normal-case latency. This was NOT
 * given the same treatment as `SpawnHandshake` (see that module's header),
 * which explicitly opts out of `PollScheduler`: a spawn handshake is a
 * per-spawn, sub-second, self-terminating wait, where sharing the scheduler's
 * idle backoff would either pin the whole scheduler near its floor for its
 * duration or starve the wait of the low latency it needs. A control-inbox
 * watch is the opposite shape - one long-lived subscriber per run, alive for
 * the run's whole lifetime, checking infrequently - which is exactly the
 * "channels, watchers, inspectors" category `PollScheduler` exists to
 * coordinate.
 *
 * A subscriber's `run()` throwing is not swallowed here: it is left to
 * propagate out of `check()` so `PollScheduler.tick()` catches it and records
 * it as `lastSubscriberError`, which is what makes FIX 2's rethrown
 * permission failures actually visible instead of merely "not silently
 * deleted".
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicJson } from '../atomicJson';
import { resolveWatchPath } from '../filesystem/configDir';
import type { PollSchedulerContract } from '../pollScheduler';

/**
 * Opportunistic fast-path interrupt signal. On Unix `SIGUSR2` is trapped by
 * the runner; on Windows `process.kill(pid, "SIGBREAK")` is not deliverable
 * cross-process and throws `ENOSYS`, so the file inbox below is the real
 * channel there.
 */
export const INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === 'win32' ? 'SIGBREAK' : 'SIGUSR2';

/** How generously the poll safety net is spaced. `fs.watch` is the fast path; see the module header. */
const DEFAULT_CONTROL_CHANNEL_POLL_INTERVAL_MS = 1_000;

export type ControlChannelFs = Pick<
  typeof fs,
  'mkdirSync' | 'existsSync' | 'rmSync' | 'renameSync' | 'watch' | 'readdirSync' | 'readFileSync' | 'realpathSync'
>;
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => unknown;

export interface InterruptRequest {
  type: 'interrupt';
  ts?: number;
  source?: string;
  reason?: string;
}

export interface TimeoutRequest {
  type: 'timeout';
  ts?: number;
  source?: string;
  reason?: string;
}

export interface StopRequest {
  type: 'stop';
  ts?: number;
  source?: string;
  reason?: string;
}

export interface SteerRequest {
  type: 'steer';
  id: string;
  ts: number;
  message: string;
  targetIndex?: number;
  targetIndexes?: number[];
  source?: string;
}

export interface SteerCapability {
  type: 'steer-capability';
  protocolVersion: 1;
  index: number;
  pid: number;
  readyAt: number;
  supported: boolean;
}

export interface SteerAck {
  type: 'steer-ack';
  protocolVersion: 1;
  requestId: string;
  index: number;
  ts: number;
  state: 'delivered' | 'failed';
  message: string;
}

const STEER_REQUESTS_DIR = 'steer-requests';
const STEER_TARGETS_DIR = 'steer-targets';
const STEER_CAPABILITIES_DIR = 'steer-capabilities';
const STEER_ACKS_DIR = 'steer-acks';
const STEER_INBOX_CLOSED_FILE = 'steer-inbox-closed.json';
const MAX_STEER_MESSAGE_BYTES = 128 * 1024;
/**
 * Highest child index a steer may address.
 *
 * A bound rather than a real limit: it exists so a malformed or hostile
 * request cannot make the runner allocate or iterate over an absurd range.
 */
const MAX_STEER_TARGET_INDEX = 1_000_000;
/** Most children one steer may address at once, for the same reason. */
const MAX_STEER_TARGET_COUNT = 1_000;
const MAX_STEER_REQUEST_ID_LENGTH = 256;
const MAX_STEER_ACK_MESSAGE_LENGTH = 1_000;
/** Suffix appended to a steer request's file name while a consumer is dispatching it. */
const CLAIM_SUFFIX_PREFIX = '.claim-';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Control inbox directory inside an async run dir. */
export function controlInboxDir(asyncDir: string): string {
  return path.join(asyncDir, 'control');
}

/** Path of the portable interrupt request file. */
export function interruptRequestPath(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), 'interrupt.json');
}

/** Path of the portable timeout request file. */
export function timeoutRequestPath(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), 'timeout.json');
}

/** Path of the portable manual stop request file. */
export function stopRequestPath(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), 'stop.json');
}

/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

export function steerInboxClosedPath(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), STEER_INBOX_CLOSED_FILE);
}

export function closeSteerInbox(asyncDir: string, state: string): void {
  writeAtomicJson(steerInboxClosedPath(asyncDir), { version: 1, closedAt: Date.now(), state });
}

/** Per-child inbox consumed by the child prompt runtime inside the Pi process. */
export function stepSteerInboxDir(asyncDir: string, index: number): string {
  assertChildIndex(index);
  return path.join(controlInboxDir(asyncDir), STEER_TARGETS_DIR, String(index));
}

export function steerCapabilitiesDir(asyncDir: string): string {
  return path.join(controlInboxDir(asyncDir), STEER_CAPABILITIES_DIR);
}

export function steerCapabilityPath(asyncDir: string, index: number): string {
  assertChildIndex(index);
  return path.join(steerCapabilitiesDir(asyncDir), `${index}.json`);
}

export function steerAcksDir(asyncDir: string, index: number): string {
  assertChildIndex(index);
  return path.join(controlInboxDir(asyncDir), STEER_ACKS_DIR, String(index));
}

function steerAckFileName(requestId: string): string {
  return `${Buffer.from(requestId).toString('base64url')}.json`;
}

export function steerAckPathFromDir(dir: string, requestId: string): string {
  if (!/^[^\s]+$/.test(requestId) || requestId.length > MAX_STEER_REQUEST_ID_LENGTH)
    throw new Error('steer acknowledgment requestId is invalid.');
  return path.join(dir, steerAckFileName(requestId));
}

function assertChildIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_STEER_TARGET_INDEX)
    throw new Error('steer child index must be a non-negative integer.');
}

function steerRequestFileName(request: SteerRequest): string {
  return `${String(request.ts).padStart(13, '0')}-${Buffer.from(request.id).toString('base64url')}.json`;
}

function validSteerRequest(request: Partial<SteerRequest>): request is SteerRequest {
  return (
    request.type === 'steer' &&
    typeof request.id === 'string' &&
    /^[^\s]+$/.test(request.id) &&
    request.id.length <= MAX_STEER_REQUEST_ID_LENGTH &&
    typeof request.ts === 'number' &&
    Number.isFinite(request.ts) &&
    request.ts > 0 &&
    typeof request.message === 'string' &&
    Boolean(request.message.trim()) &&
    Buffer.byteLength(request.message, 'utf8') <= MAX_STEER_MESSAGE_BYTES &&
    (request.targetIndex === undefined ||
      (Number.isInteger(request.targetIndex) &&
        request.targetIndex >= 0 &&
        request.targetIndex <= MAX_STEER_TARGET_INDEX)) &&
    (request.targetIndexes === undefined ||
      (request.targetIndex === undefined &&
        Array.isArray(request.targetIndexes) &&
        request.targetIndexes.length > 0 &&
        request.targetIndexes.length <= MAX_STEER_TARGET_COUNT &&
        request.targetIndexes.every(
          (index) => Number.isInteger(index) && index >= 0 && index <= MAX_STEER_TARGET_INDEX,
        ) &&
        new Set(request.targetIndexes).size === request.targetIndexes.length)) &&
    (request.source === undefined ||
      (typeof request.source === 'string' && Boolean(request.source.trim()) && request.source.length <= 256))
  );
}

export function writeSteerRequestToDir(dir: string, request: SteerRequest): string {
  if (!validSteerRequest(request)) throw new Error('steer request is malformed or exceeds transport limits.');
  const requestPath = path.join(dir, steerRequestFileName(request));
  writeAtomicJson(requestPath, request);
  return requestPath;
}

export function writeSteerCapabilityAt(
  filePath: string,
  capability: Omit<SteerCapability, 'type' | 'protocolVersion'>,
): string {
  assertChildIndex(capability.index);
  if (!Number.isInteger(capability.pid) || capability.pid <= 0)
    throw new Error('steer capability pid must be a positive integer.');
  if (!Number.isFinite(capability.readyAt) || capability.readyAt <= 0)
    throw new Error('steer capability readyAt must be a finite timestamp.');
  const record: SteerCapability = { type: 'steer-capability', protocolVersion: 1, ...capability };
  writeAtomicJson(filePath, record);
  return filePath;
}

export function writeSteerCapability(
  asyncDir: string,
  capability: Omit<SteerCapability, 'type' | 'protocolVersion'>,
): string {
  return writeSteerCapabilityAt(steerCapabilityPath(asyncDir, capability.index), capability);
}

export function writeSteerAckAt(filePath: string, ack: Omit<SteerAck, 'type' | 'protocolVersion'>): string {
  assertChildIndex(ack.index);
  if (!/^[^\s]+$/.test(ack.requestId) || ack.requestId.length > MAX_STEER_REQUEST_ID_LENGTH)
    throw new Error('steer acknowledgment requestId is invalid.');
  if (!Number.isFinite(ack.ts) || ack.ts <= 0) throw new Error('steer acknowledgment ts must be a finite timestamp.');
  if (!ack.message.trim() || ack.message.length > MAX_STEER_ACK_MESSAGE_LENGTH)
    throw new Error('steer acknowledgment message is invalid.');
  const record: SteerAck = { type: 'steer-ack', protocolVersion: 1, ...ack, message: ack.message.trim() };
  writeAtomicJson(filePath, record);
  return filePath;
}

export function writeSteerAck(asyncDir: string, ack: Omit<SteerAck, 'type' | 'protocolVersion'>): string {
  return writeSteerAckAt(path.join(steerAcksDir(asyncDir, ack.index), steerAckFileName(ack.requestId)), ack);
}

/**
 * Parent side: drop a portable interrupt request the runner's inbox watcher
 * will pick up regardless of OS. Written atomically (temp + rename), dir
 * auto-created.
 */
export function requestAsyncInterrupt(
  asyncDir: string,
  payload: Omit<InterruptRequest, 'type'> = {},
  deps: { now?: () => number } = {},
): string {
  const requestPath = interruptRequestPath(asyncDir);
  const request: InterruptRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: 'interrupt' };
  writeAtomicJson(requestPath, request);
  return requestPath;
}

export function requestAsyncTimeout(
  asyncDir: string,
  payload: Omit<TimeoutRequest, 'type'> = {},
  deps: { now?: () => number } = {},
): string {
  const requestPath = timeoutRequestPath(asyncDir);
  const request: TimeoutRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: 'timeout' };
  writeAtomicJson(requestPath, request);
  return requestPath;
}

export function requestAsyncStop(
  asyncDir: string,
  payload: Omit<StopRequest, 'type'> = {},
  deps: { now?: () => number } = {},
): string {
  const requestPath = stopRequestPath(asyncDir);
  const request: StopRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: 'stop' };
  writeAtomicJson(requestPath, request);
  return requestPath;
}

export function requestAsyncSteer(
  asyncDir: string,
  payload: {
    message: string;
    targetIndex?: number;
    targetIndexes?: number[];
    source?: string;
    id?: string;
    ts?: number;
  },
  deps: { now?: () => number; randomId?: () => string } = {},
): string {
  const message = payload.message.trim();
  if (!message) throw new Error('steer message must not be empty.');
  if (Buffer.byteLength(message, 'utf8') > MAX_STEER_MESSAGE_BYTES)
    throw new Error(`steer message exceeds ${MAX_STEER_MESSAGE_BYTES} UTF-8 bytes.`);
  if (
    payload.targetIndex !== undefined &&
    (!Number.isInteger(payload.targetIndex) || payload.targetIndex < 0 || payload.targetIndex > MAX_STEER_TARGET_INDEX)
  ) {
    throw new Error('steer targetIndex must be an integer between 0 and 1000000.');
  }
  if (
    payload.targetIndexes !== undefined &&
    (!Array.isArray(payload.targetIndexes) ||
      payload.targetIndex !== undefined ||
      payload.targetIndexes.length === 0 ||
      payload.targetIndexes.length > MAX_STEER_TARGET_COUNT ||
      payload.targetIndexes.some((index) => !Number.isInteger(index) || index < 0 || index > MAX_STEER_TARGET_INDEX) ||
      new Set(payload.targetIndexes).size !== payload.targetIndexes.length)
  ) {
    throw new Error(
      'steer targetIndexes must contain 1-1000 unique non-negative integers and cannot be combined with targetIndex.',
    );
  }
  const closedPath = steerInboxClosedPath(asyncDir);
  if (fs.existsSync(closedPath)) throw new Error('Async run no longer accepts steering requests.');
  const request: SteerRequest = {
    type: 'steer',
    id: payload.id ?? deps.randomId?.() ?? randomUUID(),
    ts: payload.ts ?? deps.now?.() ?? Date.now(),
    message,
    ...(payload.targetIndex !== undefined ? { targetIndex: payload.targetIndex } : {}),
    ...(payload.targetIndexes !== undefined ? { targetIndexes: [...payload.targetIndexes] } : {}),
    ...(payload.source ? { source: payload.source } : {}),
  };
  const requestPath = writeSteerRequestToDir(steerRequestsDir(asyncDir), request);
  if (fs.existsSync(closedPath)) {
    fs.rmSync(requestPath, { force: true });
    throw new Error('Async run stopped accepting steering before the request was committed.');
  }
  return requestPath;
}

export function enqueueStepSteer(asyncDir: string, index: number, request: SteerRequest): string {
  assertChildIndex(index);
  const { targetIndexes: _targetIndexes, ...singleTargetRequest } = request;
  return writeSteerRequestToDir(stepSteerInboxDir(asyncDir, index), {
    ...singleTargetRequest,
    targetIndex: index,
    type: 'steer',
  });
}

// ---------------------------------------------------------------------------
// Parsing. Everything read off disk arrives as `unknown` and is narrowed here;
// nothing is asserted into shape.
// ---------------------------------------------------------------------------

function parseSteerCapability(raw: unknown): SteerCapability | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Partial<SteerCapability>;
  if (input.type !== 'steer-capability' || input.protocolVersion !== 1) return undefined;
  const index = input.index;
  const pid = input.pid;
  const readyAt = input.readyAt;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_STEER_TARGET_INDEX)
    return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof readyAt !== 'number' || !Number.isFinite(readyAt) || readyAt <= 0) return undefined;
  if (typeof input.supported !== 'boolean') return undefined;
  return {
    type: 'steer-capability',
    protocolVersion: 1,
    index,
    pid,
    readyAt,
    supported: input.supported,
  };
}

function parseSteerAck(raw: unknown): SteerAck | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Partial<SteerAck>;
  if (
    input.type !== 'steer-ack' ||
    input.protocolVersion !== 1 ||
    typeof input.requestId !== 'string' ||
    !/^[^\s]+$/.test(input.requestId) ||
    input.requestId.length > MAX_STEER_REQUEST_ID_LENGTH
  )
    return undefined;
  const index = input.index;
  const ts = input.ts;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_STEER_TARGET_INDEX)
    return undefined;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return undefined;
  if (input.state !== 'delivered' && input.state !== 'failed') return undefined;
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 1000) return undefined;
  return {
    type: 'steer-ack',
    protocolVersion: 1,
    requestId: input.requestId,
    index,
    ts,
    state: input.state,
    message: input.message.trim(),
  };
}

function parseSteerRequest(raw: unknown): SteerRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Partial<SteerRequest>;
  if (!validSteerRequest(input)) return undefined;
  return {
    type: 'steer',
    id: input.id.trim(),
    ts: input.ts,
    message: input.message.trim(),
    ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
    ...(input.targetIndexes !== undefined ? { targetIndexes: [...input.targetIndexes] } : {}),
    ...(typeof input.source === 'string' && input.source.trim() ? { source: input.source } : {}),
  };
}

// ---------------------------------------------------------------------------
// Deletion. `removeIfPresent` is the one place this module deletes a control
// file, and it is FIX 2 in one function: `ENOENT` is the routine "someone
// else already consumed this" case and is absorbed; anything else means this
// run's control channel is broken and must be surfaced to the caller.
// ---------------------------------------------------------------------------

function removeIfPresent(target: string, fsImpl: Pick<typeof fs, 'rmSync'>): void {
  try {
    fsImpl.rmSync(target, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export function consumeSteerCapabilities(
  asyncDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync'> = fs,
): SteerCapability[] {
  const dir = steerCapabilitiesDir(asyncDir);
  if (!fsImpl.existsSync(dir)) return [];
  const capabilities: SteerCapability[] = [];
  for (const entry of fsImpl
    .readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort()) {
    try {
      const capability = parseSteerCapability(JSON.parse(fsImpl.readFileSync(path.join(dir, entry), 'utf-8')));
      if (capability) capabilities.push(capability);
    } catch {
      // A partially written or malformed capability is ignored until a valid one arrives.
    }
  }
  return capabilities;
}

export function consumeSteerAcks(
  asyncDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync' | 'rmSync'> = fs,
): SteerAck[] {
  const root = path.join(controlInboxDir(asyncDir), STEER_ACKS_DIR);
  if (!fsImpl.existsSync(root)) return [];
  const acks: SteerAck[] = [];
  let indexNames: string[];
  try {
    indexNames = fsImpl.readdirSync(root).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  for (const indexName of indexNames) {
    const dir = path.join(root, indexName);
    let entries: string[];
    try {
      entries = fsImpl
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry);
      let ack: SteerAck | undefined;
      try {
        ack = parseSteerAck(JSON.parse(fsImpl.readFileSync(target, 'utf-8')));
      } catch {
        ack = undefined;
      }
      // FIX 2: a missing ack file just means another reader already took it;
      // any other failure means this ack's fate is unknown and must not be
      // reported as delivered, so it is not pushed and the error propagates.
      removeIfPresent(target, fsImpl);
      if (ack) acks.push(ack);
    }
  }
  return acks;
}

/**
 * Consume one request-specific acknowledgment without touching concurrent
 * callers' files. The request id determines the exact file name, so two
 * parents waiting on different steering requests cannot steal each other's
 * result.
 */
export function consumeSteerAck(
  asyncDir: string,
  index: number,
  requestId: string,
  fsImpl: Pick<typeof fs, 'readFileSync' | 'rmSync'> = fs,
): SteerAck | undefined {
  const target = steerAckPathFromDir(steerAcksDir(asyncDir, index), requestId);
  let ack: SteerAck | undefined;
  try {
    ack = parseSteerAck(JSON.parse(fsImpl.readFileSync(target, 'utf-8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  removeIfPresent(target, fsImpl);
  if (!ack || ack.requestId !== requestId || ack.index !== index) return undefined;
  return ack;
}

export function consumeInterruptRequest(
  asyncDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'rmSync'> = fs,
): boolean {
  const requestPath = interruptRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  removeIfPresent(requestPath, fsImpl);
  return true;
}

export function consumeTimeoutRequest(
  asyncDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'rmSync'> = fs,
): boolean {
  const requestPath = timeoutRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  removeIfPresent(requestPath, fsImpl);
  return true;
}

export function consumeStopRequest(asyncDir: string, fsImpl: Pick<typeof fs, 'existsSync' | 'rmSync'> = fs): boolean {
  const requestPath = stopRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  removeIfPresent(requestPath, fsImpl);
  return true;
}

// ---------------------------------------------------------------------------
// FIX 1: claim by rename, dispatch what was claimed, commit or release.
// ---------------------------------------------------------------------------

/** A steer request removed from the queue by an atomic rename, awaiting dispatch. */
export interface ClaimedSteerRequest {
  request: SteerRequest;
  /** Call once dispatch has returned successfully. Permanently deletes the claimed file. */
  commit: () => void;
  /** Call when dispatch threw. Renames the file back so the next scan retries it. */
  release: () => void;
}

/**
 * Atomically move one queued request out of `dir`, or report the loss to
 * another consumer.
 *
 * `renameSync` on `original` is what decides a single winner: if two
 * consumers both listed `dir` and both attempt this for the same
 * `entryName`, exactly one rename succeeds and the other's source no longer
 * exists, which surfaces as `ENOENT` here regardless of what destination name
 * either consumer chose.
 */
function claimSteerRequestFile(
  dir: string,
  entryName: string,
  claimant: string,
  fsImpl: Pick<typeof fs, 'renameSync'>,
): string | undefined {
  const original = path.join(dir, entryName);
  const claimed = `${original}${CLAIM_SUFFIX_PREFIX}${claimant}`;
  try {
    fsImpl.renameSync(original, claimed);
    return claimed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Claim every currently queued, parseable steer request in `dir`.
 *
 * Each returned entry has already been renamed out of the queue, so nothing
 * else will claim it again; it is the caller's obligation to call exactly one
 * of `commit()` (dispatch succeeded) or `release()` (dispatch threw) for
 * every entry returned, so nothing is left claimed and stranded.
 */
export function claimSteerRequestsFromDir(
  dir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'renameSync' | 'rmSync' | 'readdirSync' | 'readFileSync'> = fs,
  claimant: string = randomUUID(),
): ClaimedSteerRequest[] {
  if (!fsImpl.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fsImpl
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    // Leave requests in place so the next scan can retry the listing.
    return [];
  }
  const claims: ClaimedSteerRequest[] = [];
  for (const entryName of entries) {
    const claimedPath = claimSteerRequestFile(dir, entryName, claimant, fsImpl);
    if (!claimedPath) continue; // Lost the race to another consumer, or already gone.
    const originalPath = path.join(dir, entryName);
    let parsed: SteerRequest | undefined;
    try {
      parsed = parseSteerRequest(JSON.parse(fsImpl.readFileSync(claimedPath, 'utf-8')));
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      // Corrupt or unparseable: nothing can dispatch it, and it is not
      // something a future poll should keep retrying forever.
      removeIfPresent(claimedPath, fsImpl);
      continue;
    }
    let settled = false;
    claims.push({
      request: parsed,
      commit: () => {
        if (settled) return;
        settled = true;
        removeIfPresent(claimedPath, fsImpl);
      },
      release: () => {
        if (settled) return;
        settled = true;
        try {
          fsImpl.renameSync(claimedPath, originalPath);
        } catch {
          // The original name is occupied (astronomically unlikely - it is
          // keyed by timestamp and id) or the directory is gone. Either way
          // there is nothing left to preserve by retrying the rename; drop
          // the claimed copy rather than leave an unreachable file on disk.
          removeIfPresent(claimedPath, fsImpl);
        }
      },
    });
  }
  return claims.sort(
    (left, right) => left.request.ts - right.request.ts || left.request.id.localeCompare(right.request.id),
  );
}

export function claimSteerRequests(
  asyncDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'renameSync' | 'rmSync' | 'readdirSync' | 'readFileSync'> = fs,
  claimant: string = randomUUID(),
): ClaimedSteerRequest[] {
  return claimSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl, claimant);
}

// ---------------------------------------------------------------------------
// Parent-side portable delivery. Authoritative file request + best-effort OS
// signal; the signal is only a latency optimization on Unix, and `ENOSYS` on
// Windows is expected and swallowed because the file inbox is authoritative
// there. Other signal failures are surfaced because they usually mean the
// runner is not alive to consume the request.
// ---------------------------------------------------------------------------

export function deliverInterruptRequest(input: {
  asyncDir: string;
  pid?: number;
  kill?: KillFn;
  signal?: NodeJS.Signals;
  now?: () => number;
  source?: string;
}): void {
  const requestPath = requestAsyncInterrupt(input.asyncDir, input.source ? { source: input.source } : {}, {
    now: input.now,
  });
  if (typeof input.pid === 'number' && input.pid > 0) {
    try {
      const kill = input.kill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
      kill(input.pid, input.signal ?? INTERRUPT_SIGNAL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOSYS') {
        // File inbox is authoritative when custom cross-process signals are unavailable.
        return;
      }
      try {
        fs.rmSync(requestPath, { force: true });
      } catch {
        // Best effort cleanup; the caller still gets the signal failure.
      }
      throw error;
    }
  }
}

export function deliverTimeoutRequest(input: {
  asyncDir: string;
  pid?: number;
  kill?: KillFn;
  signal?: NodeJS.Signals;
  now?: () => number;
  source?: string;
}): void {
  requestAsyncTimeout(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}

export function deliverStopRequest(input: {
  asyncDir: string;
  pid?: number;
  kill?: KillFn;
  signal?: NodeJS.Signals;
  now?: () => number;
  source?: string;
}): void {
  requestAsyncStop(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}

// ---------------------------------------------------------------------------
// Runner side: watch the inbox and route requests into caller-supplied
// handlers. See the module header for why this is a `PollScheduler`
// subscriber rather than an owned timer.
// ---------------------------------------------------------------------------

export interface ControlChannelWatchHandlers {
  onInterrupt: () => void;
  onTimeout?: () => void;
  onStop?: () => void;
  onSteer?: (request: SteerRequest) => void;
  onSteerCapability?: (capability: SteerCapability) => void;
  onSteerAck?: (ack: SteerAck) => void;
}

export interface ControlChannelWatchOptions {
  /** Poll safety-net cadence for this watch, overriding the service default. */
  intervalMs?: number;
  fs?: ControlChannelFs;
}

export type ControlChannelWatcherContract = {
  /**
   * Start watching `asyncDir`'s control inbox. Fires the matching handler for
   * each distinct request, once. Returns a disposer.
   */
  watch(asyncDir: string, handlers: ControlChannelWatchHandlers, options?: ControlChannelWatchOptions): () => void;
};

export class ControlChannelWatcher implements ControlChannelWatcherContract {
  /**
   * Runtime tuning seam for tests, kept out of the dependency constructor.
   */
  protected readonly intervalMs: number = DEFAULT_CONTROL_CHANNEL_POLL_INTERVAL_MS;

  constructor(private readonly scheduler: PollSchedulerContract) {}

  watch(asyncDir: string, handlers: ControlChannelWatchHandlers, options: ControlChannelWatchOptions = {}): () => void {
    const fsImpl = options.fs ?? fs;
    const dir = controlInboxDir(asyncDir);
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
    } catch {
      // Best effort - check() below tolerates a missing dir.
    }

    const claimant = `${process.pid}-${randomUUID()}`;
    let disposed = false;

    const run = (): boolean => {
      if (disposed) return false;
      return this.check(asyncDir, handlers, fsImpl, claimant);
    };

    // A request may already be waiting before this watcher starts. Its error,
    // if any, is allowed to throw out of `watch()` here: the scheduled
    // subscription below is not registered yet to report it, and a control
    // channel broken before the first check ever runs should fail loudly
    // rather than start silently degraded.
    run();

    const unregister = this.scheduler.register({
      id: `control-channel:${asyncDir}`,
      intervalMs: options.intervalMs ?? this.intervalMs,
      run,
    });

    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fsImpl.watch(resolveWatchPath(dir, fsImpl.realpathSync.native), () => {
        if (!disposed) this.scheduler.wake();
      });
      watcher.on?.('error', () => {
        // fs.watch can emit on transient FS errors; the poll subscription
        // above keeps this live regardless.
      });
    } catch {
      watcher = undefined;
    }

    return () => {
      if (disposed) return;
      disposed = true;
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      unregister();
    };
  }

  /**
   * One pass over every request kind. Returns whether anything was actually
   * consumed, which is what lets `PollScheduler`'s idle backoff reset.
   *
   * Steer capabilities are deliberately excluded from that signal: unlike
   * every other request kind, a capability file is not consumed here (it
   * represents current state, not a one-time event), so counting its mere
   * presence as "work" would pin this subscription at its floor interval for
   * as long as any child has ever registered one.
   *
   * A steer dispatch that throws does not abort the pass: every claim is
   * either committed or released before this returns (FIX 1), and any error
   * is collected and rethrown last so one failing message cannot starve the
   * others claimed in the same pass.
   */
  private check(
    asyncDir: string,
    handlers: ControlChannelWatchHandlers,
    fsImpl: ControlChannelFs,
    claimant: string,
  ): boolean {
    let workHappened = false;

    if (consumeStopRequest(asyncDir, fsImpl)) {
      handlers.onStop?.();
      workHappened = true;
    }
    if (consumeTimeoutRequest(asyncDir, fsImpl)) {
      handlers.onTimeout?.();
      workHappened = true;
    }
    if (consumeInterruptRequest(asyncDir, fsImpl)) {
      handlers.onInterrupt();
      workHappened = true;
    }

    let firstError: unknown;
    for (const claim of claimSteerRequests(asyncDir, fsImpl, claimant)) {
      try {
        handlers.onSteer?.(claim.request);
        claim.commit();
        workHappened = true;
      } catch (error) {
        claim.release();
        firstError ??= error;
      }
    }

    for (const capability of consumeSteerCapabilities(asyncDir, fsImpl)) handlers.onSteerCapability?.(capability);
    // The child runner writes acknowledgments for its parent. A watcher that
    // has no acknowledgment handler must leave those files untouched, or it
    // races the parent and consumes its own outbound acknowledgment.
    if (handlers.onSteerAck) {
      for (const ack of consumeSteerAcks(asyncDir, fsImpl)) {
        handlers.onSteerAck(ack);
        workHappened = true;
      }
    }

    if (firstError !== undefined) throw firstError;
    return workHappened;
  }
}
