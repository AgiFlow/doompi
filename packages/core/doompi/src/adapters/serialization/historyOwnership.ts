import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryOwnership, HistoryOwnershipLease } from './historyImport.ts';

const LOCK_SUFFIX = '.doompi-v4.lock';
const LOCK_VERSION = 1;
const LOCK_FORMAT = 'doompi-v4-history-ownership';

interface HistoryLockRecord {
  version: 1;
  format: 'doompi-v4-history-ownership';
  pid: number;
  sourcePath: string;
  token: string;
}

interface HeldHistoryLock {
  lockPath: string;
  token: string;
  handle: number;
}

export interface HistoryOwnershipOptions {
  /** Checks managed writers; this cannot account for an unmanaged Pi process. */
  assertQuiescent?: (sourcePath: string) => void | Promise<void>;
  /** The source format admitted by this owner. Defaults to canonical v4. */
  sourceFormat?: 'v3' | 'v4';
  /** Additional paths to lock for the lifetime of each acquired source lease. */
  additionalPaths?: readonly string[];
}

function canonicalSourcePath(sourcePath: string): string {
  const absolute = path.resolve(sourcePath);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const segments = [path.basename(absolute)];
  let parent = path.dirname(absolute);
  while (!fs.existsSync(parent)) {
    segments.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  return path.join(fs.realpathSync(parent), ...segments);
}

/** Resolve aliases so every writer and exporter contends for the same lock. */
export function historyOwnershipLockPath(sourcePath: string): string {
  return `${canonicalSourcePath(sourcePath)}${LOCK_SUFFIX}`;
}

function isHistoryObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isV4Header(value: unknown): boolean {
  return isHistoryObject(value) && value.kind === 'header' && value.v === 4;
}

function isV3Header(value: unknown): boolean {
  return isHistoryObject(value) && value.type === 'session' && value.version === 3;
}

function readHeader(sourcePath: string, format: 'v3' | 'v4'): unknown {
  const firstLine = fs.readFileSync(sourcePath, 'utf8').split('\n', 1)[0] ?? '';
  try {
    return JSON.parse(firstLine);
  } catch (error) {
    const message =
      format === 'v4'
        ? `History ownership source is not canonical v4 JSONL: ${sourcePath}`
        : `Offline history source is not canonical v3 JSONL: ${sourcePath}`;
    throw new Error(message, { cause: error });
  }
}

function assertIndependentRegularFile(sourcePath: string, label: string): void {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${label} must be an independent regular file`);
}

function assertV4Source(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  assertIndependentRegularFile(sourcePath, 'Canonical history');
  if (!isV4Header(readHeader(sourcePath, 'v4')))
    throw new Error(`History ownership only supports canonical v4 sources: ${sourcePath}`);
}

function assertV3Source(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  assertIndependentRegularFile(sourcePath, 'Offline v3 history source');
  if (!isV3Header(readHeader(sourcePath, 'v3')))
    throw new Error(`Offline history import only supports v3 sources: ${sourcePath}`);
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function readToken(lockPath: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<HistoryLockRecord>;
    return typeof value.token === 'string' ? value.token : undefined;
  } catch {
    return undefined;
  }
}

function releaseLock(lockPath: string, token: string, handle: number): void {
  fs.closeSync(handle);
  // An unrecognisable or replaced lock is ambiguous. Never remove it merely
  // because its recorded pid is gone or its contents look stale.
  if (readToken(lockPath) === token) fs.rmSync(lockPath, { force: true });
}

function createLease(
  locks: readonly HeldHistoryLock[],
  sourcePath: string,
  assertQuiescent: (sourcePath: string) => void | Promise<void>,
): HistoryOwnershipLease {
  let released = false;
  return {
    assertQuiescent: () => {
      if (released) throw new Error('History ownership lease has been released');
      for (const lock of locks) {
        const held = fs.fstatSync(lock.handle);
        const current = fs.statSync(lock.lockPath);
        if (held.dev !== current.dev || held.ino !== current.ino || readToken(lock.lockPath) !== lock.token) {
          throw new Error('History ownership lock was replaced');
        }
      }
      return assertQuiescent(sourcePath);
    },
    release: () => {
      if (released) return;
      released = true;
      let firstError: unknown;
      for (const lock of [...locks].reverse()) {
        try {
          releaseLock(lock.lockPath, lock.token, lock.handle);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}

/**
 * Creates the canonical history owner used by runtime writers, export CLI, and
 * the explicit offline importer. The default source boundary remains v4.
 * Locks are deliberately never reclaimed from dead pids: a stale or malformed
 * sidecar needs explicit operator cleanup because it cannot prove quiescence.
 */
export function createHistoryOwnership(options: HistoryOwnershipOptions = {}): HistoryOwnership {
  const assertQuiescent = options.assertQuiescent ?? (() => undefined);
  const assertSource = options.sourceFormat === 'v3' ? assertV3Source : assertV4Source;
  return {
    async acquire(sourcePath: string): Promise<HistoryOwnershipLease> {
      const absoluteSourcePath = canonicalSourcePath(sourcePath);
      const paths = [absoluteSourcePath, ...(options.additionalPaths ?? [])].map(canonicalSourcePath);
      const canonicalPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
      const locks: HeldHistoryLock[] = [];
      let conflictingLockPath = historyOwnershipLockPath(absoluteSourcePath);
      try {
        for (const lockedPath of canonicalPaths) {
          const lockPath = historyOwnershipLockPath(lockedPath);
          conflictingLockPath = lockPath;
          const token = randomUUID();
          const record: HistoryLockRecord = {
            version: LOCK_VERSION,
            format: LOCK_FORMAT,
            pid: process.pid,
            sourcePath: lockedPath,
            token,
          };
          fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
          const handle = fs.openSync(lockPath, 'wx', 0o600);
          const lock = { lockPath, token, handle };
          locks.push(lock);
          fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
          fs.fsyncSync(handle);
        }
        assertSource(absoluteSourcePath);
      } catch (error) {
        for (const lock of [...locks].reverse()) {
          try {
            releaseLock(lock.lockPath, lock.token, lock.handle);
          } catch {
            // Preserve the acquisition failure and never remove a replaced lock.
          }
        }
        if (isFileSystemError(error) && error.code === 'EEXIST') {
          throw new Error(`History ownership lock already exists or is ambiguous: ${conflictingLockPath}`, {
            cause: error,
          });
        }
        throw error;
      }
      return createLease(locks, absoluteSourcePath, assertQuiescent);
    },
  };
}

/** Explicitly named alias for hosts that want to document the v4 boundary. */
export const createV4HistoryOwnership = createHistoryOwnership;
