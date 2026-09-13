import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
const LOCK_OWNER_FILE = 'owner.json';

export interface HistoryLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  random?: () => number;
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

export interface HistoryLock {
  path: string;
  token: string;
  release(): void;
}

function isPidAlive(pid: number, currentPid: number): boolean {
  if (pid === currentPid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const owner = parsed as Partial<LockOwner>;
    if (typeof owner.token !== 'string' || typeof owner.pid !== 'number' || !Number.isFinite(owner.createdAt))
      return null;
    const token = owner.token;
    const pid = owner.pid;
    const createdAt = owner.createdAt;
    if (token === undefined || pid === undefined || createdAt === undefined) return null;
    return { token, pid, createdAt };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStale(lockPath: string, staleMs: number, now: number, pidAlive: (pid: number) => boolean): boolean {
  const owner = readOwner(lockPath);
  if (!owner) {
    try {
      const stat = fs.statSync(lockPath);
      return now - stat.mtimeMs >= staleMs;
    } catch {
      return false;
    }
  }
  return now - owner.createdAt >= staleMs || !pidAlive(owner.pid);
}

function removeStaleLock(lockPath: string, staleMs: number, now: number, pidAlive: (pid: number) => boolean): boolean {
  if (!isStale(lockPath, staleMs, now, pidAlive)) return false;
  const moved = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, moved);
    fs.rmSync(moved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function acquireHistoryLock(lockPath: string, options: HistoryLockOptions = {}): Promise<HistoryLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const pidAlive = options.pidAlive ?? ((pid: number) => isPidAlive(pid, process.pid));
  const random = options.random ?? Math.random;
  const startedAt = now();
  const token = randomUUID();
  fs.mkdirSync(path.dirname(lockPath), { mode: PRIVATE_DIRECTORY_MODE, recursive: true });

  while (now() - startedAt <= timeoutMs) {
    try {
      fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      fs.writeFileSync(
        path.join(lockPath, LOCK_OWNER_FILE),
        `${JSON.stringify({ token, pid: process.pid, createdAt: now() } satisfies LockOwner)}\n`,
        { mode: PRIVATE_FILE_MODE },
      );
      return { path: lockPath, token, release: () => releaseHistoryLock(lockPath, token) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      removeStaleLock(lockPath, staleMs, now(), pidAlive);
      const remaining = timeoutMs - (now() - startedAt);
      if (remaining <= 0) break;
      await sleep(Math.min(remaining, retryMs + Math.floor(random() * Math.max(1, retryMs))));
    }
  }
  throw new Error(`Timed out acquiring Goal history lock '${lockPath}'.`);
}

export function releaseHistoryLock(lockPath: string, token: string): void {
  if (readOwner(lockPath)?.token !== token) return;
  fs.rmSync(lockPath, { recursive: true, force: true });
}

export async function withHistoryLock<T>(
  lockPath: string,
  operation: () => T | Promise<T>,
  options?: HistoryLockOptions,
): Promise<T> {
  const lock = await acquireHistoryLock(lockPath, options);
  try {
    return await operation();
  } finally {
    lock.release();
  }
}
