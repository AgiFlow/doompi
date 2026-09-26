import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { HistoryOwnership, HistoryOwnershipLease } from '../historyImport';

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
  sourceFormat?: 'v3' | 'v4' | 'sqlite';
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

function assertSqliteSource(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  assertIndependentRegularFile(sourcePath, 'SQLite history');
  const descriptor = fs.openSync(sourcePath, 'r');
  try {
    const header = Buffer.alloc(16);
    if (
      fs.readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.toString('utf8') !== 'SQLite format 3\u0000'
    )
      throw new Error(`History ownership source is not SQLite: ${sourcePath}`);
  } finally {
    fs.closeSync(descriptor);
  }
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

/** A dead owner is recoverable only when the entire lock record is recognizable. */
function readRecoverableLock(lockPath: string, sourcePath: string): HistoryLockRecord | undefined {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.nlink !== 1) return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (
      !isHistoryObject(value) ||
      value.version !== LOCK_VERSION ||
      value.format !== LOCK_FORMAT ||
      value.sourcePath !== sourcePath ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.token !== 'string' ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value.token)
    )
      return undefined;
    return value as unknown as HistoryLockRecord;
  } catch {
    return undefined;
  }
}

function ownerMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isFileSystemError(error) && error.code === 'ESRCH');
  }
}
/** A guard left by a dead acquirer can be retired without touching its source lock. */
function retireDeadGuard(guard: string): boolean {
  try {
    const stat = fs.lstatSync(guard);
    if (!stat.isDirectory()) return false;
    const entries = fs.readdirSync(guard);
    // An empty guard might still belong to a process killed between mkdir and
    // publishing its marker. Fail closed rather than race a new acquirer.
    if (entries.length !== 1 || !/^owner-[\da-f-]{36}\.json$/iu.test(entries[0]!)) return false;
    const marker = path.join(guard, entries[0]!);
    const markerStat = fs.lstatSync(marker);
    if (!markerStat.isFile() || markerStat.nlink !== 1) return false;
    const owner: unknown = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (!isHistoryObject(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
    if (ownerMayBeAlive(owner.pid as number)) return false;
    // Only the process that unlinks this unique marker may retire the directory.
    // Other cleaners see a newly empty guard and refuse to remove it.
    fs.unlinkSync(marker);
    fs.rmdirSync(guard);
    return true;
  } catch {
    return false;
  }
}

/** All new acquirers hold this guard until their ownership record is durable. */
function withAcquisitionGuard<T>(lockPath: string, acquire: () => T): T {
  const guard = `${lockPath}.recovery`;
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if (!isFileSystemError(error) || error.code !== 'EEXIST' || !retireDeadGuard(guard)) throw error;
    fs.mkdirSync(guard, { mode: 0o700 });
  }
  const marker = path.join(guard, `owner-${randomUUID()}.json`);
  try {
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    return acquire();
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmdirSync(guard);
  }
}

/** Called only under the acquisition guard, before publishing a new owner. */
function recoverDeadOwner(lockPath: string, sourcePath: string): boolean {
  try {
    const record = readRecoverableLock(lockPath, sourcePath);
    if (!record || ownerMayBeAlive(record.pid)) return false;
    const before = fs.lstatSync(lockPath);
    if (readRecoverableLock(lockPath, sourcePath)?.token !== record.token || ownerMayBeAlive(record.pid)) return false;
    const current = fs.lstatSync(lockPath);
    if (before.dev !== current.dev || before.ino !== current.ino) return false;
    // The owner is gone, and other recoverers cannot remove this lock while
    // the guard is held. Legacy writers still contend on the exclusive wx open.
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isFileSystemError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function releaseLock(lockPath: string, token: string, handle: number): void {
  fs.closeSync(handle);
  // Recovery only retires a lock after its recorded owner has exited, so that
  // owner cannot be here releasing it concurrently. A replaced lock is ambiguous.
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
 * Complete locks left by a dead process are recovered under an exclusive guard.
 * A live owner or an ambiguous sidecar still blocks acquisition.
 */
export function createHistoryOwnership(options: HistoryOwnershipOptions = {}): HistoryOwnership {
  const assertQuiescent = options.assertQuiescent ?? (() => undefined);
  const assertSource =
    options.sourceFormat === 'sqlite'
      ? assertSqliteSource
      : options.sourceFormat === 'v3'
        ? assertV3Source
        : assertV4Source;
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
          withAcquisitionGuard(lockPath, () => {
            let handle: number;
            try {
              handle = fs.openSync(lockPath, 'wx', 0o600);
            } catch (error) {
              if (!isFileSystemError(error) || error.code !== 'EEXIST' || !recoverDeadOwner(lockPath, lockedPath))
                throw error;
              handle = fs.openSync(lockPath, 'wx', 0o600);
            }
            const lock = { lockPath, token, handle };
            locks.push(lock);
            fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
            fs.fsyncSync(handle);
          });
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
