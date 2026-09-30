import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import type { DoomHostExecutionBudget } from '../../schemas/packageApi';

type Lease = Awaited<ReturnType<DoomHostExecutionBudget['acquire']>>;
interface Waiter {
  signal?: AbortSignal;
  resolve(lease: Lease): void;
  reject(reason: unknown): void;
  detach(): void;
}
interface StoredLease {
  token: string;
  owner_pid: number;
  child_pid: number | null;
  job_limit: number;
}
const MAX_QUEUED_JOBS = 128;
const RETRY_MS = 100;

function busy(error: unknown): boolean {
  return error instanceof Error && /database (?:is )?(?:locked|busy)/i.test(error.message);
}
function alive(pid: number | null): boolean {
  if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/** A local FIFO with atomic host-wide permits. SQLite never waits on its calling thread. */
export function createExecutionBudget(
  limit = 2,
  databasePath = ':memory:',
): DoomHostExecutionBudget & { close(): void } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Heavy-job limit must be a positive integer');
  const owned = new Set<string>();
  const released = new Set<string>();
  const queue: Waiter[] = [];
  let database: DatabaseSync | undefined;
  let closed = false;
  let draining = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connection = (): DatabaseSync => {
    if (database) return database;
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const next = new DatabaseSync(databasePath, { timeout: 0 });
    try {
      next.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS execution_leases (token TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, child_pid INTEGER, job_limit INTEGER NOT NULL)',
      );
      database = next;
      return next;
    } catch (error) {
      next.close();
      throw error;
    }
  };

  const claim = (): string | undefined => {
    if (owned.size >= limit) return undefined;
    let db: DatabaseSync | undefined;
    let transaction = false;
    try {
      db = connection();
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const rows = db
        .prepare('SELECT token, owner_pid, child_pid, job_limit FROM execution_leases')
        .all() as unknown as StoredLease[];
      const live: StoredLease[] = [];
      for (const row of rows) {
        // A dead host may have left a supervised child alive. Do not grant its slot again.
        if (alive(row.owner_pid) || alive(row.child_pid)) live.push(row);
        else db.prepare('DELETE FROM execution_leases WHERE token = ?').run(row.token);
      }
      const effectiveLimit = Math.min(limit, ...live.map((row) => row.job_limit));
      const token = live.length < effectiveLimit ? randomUUID() : undefined;
      if (token) db.prepare('INSERT INTO execution_leases VALUES (?, ?, NULL, ?)').run(token, process.pid, limit);
      db.exec('COMMIT');
      transaction = false;
      return token;
    } catch (error) {
      if (transaction) db?.exec('ROLLBACK');
      if (busy(error)) return undefined;
      throw error;
    }
  };

  const lease = (token: string): Lease => {
    owned.add(token);
    const release: Lease = () => {
      if (!owned.has(token) || released.has(token)) return;
      released.add(token);
      drain();
    };
    release.attachProcess = async (pid: number): Promise<void> => {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError('Child PID must be a positive integer');
      // Only admitted jobs use this retry, never every queued agent.
      for (let attempt = 0; ; attempt += 1) {
        if (!owned.has(token) || released.has(token)) return;
        try {
          connection().prepare('UPDATE execution_leases SET child_pid = ? WHERE token = ?').run(pid, token);
          return;
        } catch (error) {
          if (!busy(error) || attempt >= 49) throw error;
          await delay(RETRY_MS);
        }
      }
    };
    return release;
  };

  const schedule = (): void => {
    if (timer) {
      if (queue.length) timer.ref();
      else timer.unref();
      return;
    }
    if (!queue.length && !released.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      drain();
    }, RETRY_MS);
    if (!queue.length) timer.unref();
  };

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      for (const token of released) {
        try {
          connection().prepare('DELETE FROM execution_leases WHERE token = ?').run(token);
          released.delete(token);
          owned.delete(token);
        } catch (error) {
          // Fail closed: an unreleased permit remains reserved, never over-admitted.
          if (!busy(error)) {
            for (const waiter of queue.splice(0)) {
              waiter.detach();
              waiter.reject(error);
            }
          }
          break;
        }
      }
      while (!closed && queue.length && owned.size < limit) {
        const waiter = queue[0]!;
        try {
          const token = claim();
          if (!token) break;
          queue.shift();
          waiter.detach();
          waiter.resolve(lease(token));
        } catch (error) {
          queue.shift();
          waiter.detach();
          waiter.reject(error);
        }
      }
    } finally {
      draining = false;
      if (!queue.length && !released.size && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (closed && !owned.size) {
        database?.close();
        database = undefined;
      }
      schedule();
    }
  };

  return {
    async acquire(signal) {
      if (closed) throw new Error('The host execution budget is closed');
      signal?.throwIfAborted();
      if (!queue.length) {
        const token = claim();
        if (token) return lease(token);
      }
      if (queue.length >= MAX_QUEUED_JOBS) throw new Error('The host heavy-job queue is full');
      return new Promise<Lease>((resolve, reject) => {
        const onAbort = (): void => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          waiter.detach();
          reject(signal?.reason);
          drain();
        };
        const waiter: Waiter = { signal, resolve, reject, detach: () => signal?.removeEventListener('abort', onAbort) };
        queue.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else schedule();
      });
    },
    getSnapshot: () => ({ running: owned.size, queued: queue.length, limit }),
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of queue.splice(0)) {
        waiter.detach();
        waiter.reject(new Error('The host execution budget is closed'));
      }
      // Active leases are released by process completion, not by host shutdown alone.
      drain();
    },
  };
}

/** Reused across standalone sessions in a process; server-owned sessions pass their budget explicitly. */
const processBudgets = new Map<string, ReturnType<typeof createExecutionBudget>>();
function budgetConfig(environment: Readonly<Record<string, string | undefined>>): { file: string; limit: number } {
  return {
    file:
      environment.DOOM_RUNNER_BUDGET_DB ??
      path.join(environment.HOME ?? os.homedir(), '.pi', 'agent', 'execution-budget.db'),
    limit: Number(environment.DOOM_RUNNER_MAX_HEAVY_JOBS ?? 2),
  };
}

/** An independently owned handle sharing the same host-wide SQLite admission. */
export function createServerExecutionBudget(
  environment: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof createExecutionBudget> {
  const { file, limit } = budgetConfig(environment);
  return createExecutionBudget(limit, file);
}

export function sharedExecutionBudget(
  environment: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof createExecutionBudget> {
  const { file, limit } = budgetConfig(environment);
  const key = `${file}:${limit}`;
  let budget = processBudgets.get(key);
  if (!budget) {
    budget = createExecutionBudget(limit, file);
    const close = budget.close.bind(budget);
    budget.close = () => {
      processBudgets.delete(key);
      close();
    };
    processBudgets.set(key, budget);
  }
  return budget;
}
