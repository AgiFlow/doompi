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

export interface HistoryOwnershipOptions {
  /** Checks managed writers; this cannot account for an unmanaged Pi process. */
  assertQuiescent?: (sourcePath: string) => void | Promise<void>;
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

function isV4Header(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  return header.kind === 'header' && header.v === 4;
}

function assertV4Source(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Canonical history must be an independent regular file');
  const firstLine = fs.readFileSync(sourcePath, 'utf8').split('\n', 1)[0] ?? '';
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch (error) {
    throw new Error(`History ownership source is not canonical v4 JSONL: ${sourcePath}`, { cause: error });
  }
  if (!isV4Header(header)) throw new Error(`History ownership only supports canonical v4 sources: ${sourcePath}`);
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
  lockPath: string,
  sourcePath: string,
  token: string,
  handle: number,
  assertQuiescent: (sourcePath: string) => void | Promise<void>,
): HistoryOwnershipLease {
  let released = false;
  return {
    assertQuiescent: () => {
      if (released) throw new Error('History ownership lease has been released');
      const held = fs.fstatSync(handle);
      const current = fs.statSync(lockPath);
      if (held.dev !== current.dev || held.ino !== current.ino || readToken(lockPath) !== token) {
        throw new Error('History ownership lock was replaced');
      }
      return assertQuiescent(sourcePath);
    },
    release: () => {
      if (released) return;
      released = true;
      releaseLock(lockPath, token, handle);
    },
  };
}

/**
 * Creates the canonical v4 owner used by both runtime writers and export CLI.
 * The lock is deliberately never reclaimed from a dead pid: a stale or
 * malformed sidecar needs explicit operator cleanup because it cannot prove Pi
 * quiescence.
 */
export function createHistoryOwnership(options: HistoryOwnershipOptions = {}): HistoryOwnership {
  const assertQuiescent = options.assertQuiescent ?? (() => undefined);
  return {
    async acquire(sourcePath: string): Promise<HistoryOwnershipLease> {
      const absoluteSourcePath = canonicalSourcePath(sourcePath);
      const lockPath = historyOwnershipLockPath(absoluteSourcePath);
      const token = randomUUID();
      const record: HistoryLockRecord = {
        version: LOCK_VERSION,
        format: LOCK_FORMAT,
        pid: process.pid,
        sourcePath: absoluteSourcePath,
        token,
      };
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      let handle: number | undefined;
      try {
        handle = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(handle);
        assertV4Source(absoluteSourcePath);
      } catch (error) {
        try {
          if (handle !== undefined) fs.closeSync(handle);
        } catch {
          // Preserve the acquisition failure.
        }
        if (readToken(lockPath) === token) fs.rmSync(lockPath, { force: true });
        if (isFileSystemError(error) && error.code === 'EEXIST') {
          throw new Error(`History ownership lock already exists or is ambiguous: ${lockPath}`, { cause: error });
        }
        throw error;
      }
      if (handle === undefined) throw new Error('History ownership lock was not opened');
      return createLease(lockPath, absoluteSourcePath, token, handle, assertQuiescent);
    },
  };
}

/** Explicitly named alias for hosts that want to document the v4 boundary. */
export const createV4HistoryOwnership = createHistoryOwnership;
