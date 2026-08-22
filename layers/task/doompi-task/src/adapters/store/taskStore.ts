import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeTasks } from '../../services/store/invariants.ts';
import { isProcessAlive } from '../../services/store/processLiveness.ts';
import { emptyDocument, STORE_SCHEMA_VERSION, type Task, type TaskDocument } from '../../services/store/types.ts';
import { TASK_EVENT, type TaskFailureReporter } from '../../types/telemetry.ts';
import { lockPathFor, resolveStorePath, STORE_PATH_ENV, tempPathFor } from './paths.ts';

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_BASE_MS = 10;
const LOCK_RETRY_MAX_MS = 60;
const WATCH_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 2000;
const UTF8_ENCODING = 'utf8';
const MISSING_FILE_CODE = 'ENOENT';
const LOCK_EXISTS_CODE = 'EEXIST';
const STORE_PATH_ATTRIBUTE = 'store.path';

export type TaskStoreCommitListener = (previous: TaskDocument, committed: TaskDocument) => void;

export interface TaskStoreOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  onCommitted?: TaskStoreCommitListener;
  /** Backstop poll cadence for change detection. Lowered in tests so they do
   * not depend on `fs.watch`, whose delivery timing is platform-dependent. */
  pollIntervalMs?: number;
  /** How long to wait for the advisory lock before proceeding lock-free. */
  lockTimeoutMs?: number;
  /** Where swallowed failures go, so silent degradation stays visible. */
  report?: TaskFailureReporter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coerce arbitrary parsed JSON into a valid document.
 *
 * A corrupt or truncated store must not take the session down: the worst
 * acceptable outcome is starting from an empty list, never a crash on startup.
 */
function normalizeDocument(parsed: unknown): TaskDocument {
  if (!parsed || typeof parsed !== 'object') return emptyDocument();
  const candidate = parsed as Partial<TaskDocument>;
  if (!Array.isArray(candidate.tasks)) return emptyDocument();

  const tasks = canonicalizeTasks(
    candidate.tasks.filter(
      (task): task is Task => Boolean(task) && typeof task === 'object' && typeof (task as Task).id === 'number',
    ),
  );
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  return {
    version: typeof candidate.version === 'number' ? candidate.version : STORE_SCHEMA_VERSION,
    rev: typeof candidate.rev === 'number' ? candidate.rev : 0,
    nextId: typeof candidate.nextId === 'number' && candidate.nextId > maxId ? candidate.nextId : maxId + 1,
    tasks,
  };
}

/**
 * File-backed task store shared by one root session and its delegated children.
 *
 * Durability model: the JSON file is the source of truth. Mutations are
 * read-modify-write under an advisory lock so concurrent delegated processes
 * cannot clobber each other, and writes land via temp-file rename so a
 * crash mid-write can never leave a partial document behind.
 */
export class TaskStore {
  storePath: string;

  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private cached: TaskDocument = emptyDocument();
  private lastKnownRev = -1;
  private watcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private checkInFlight?: Promise<void>;
  private checkQueued = false;
  private watchGeneration = 0;
  private readonly listeners = new Set<(document: TaskDocument) => void>();
  private readonly pollIntervalMs: number;
  private readonly lockTimeoutMs: number;
  private readonly report?: TaskFailureReporter;
  private readonly onCommitted?: TaskStoreCommitListener;

  constructor(options: TaskStoreOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.storePath = options.storePath ?? resolveStorePath(this.cwd, this.env);
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.report = options.report;
    this.onCommitted = options.onCommitted;
  }

  /** Bind a default store to the current session tree before reading or watching it. */
  configureSession(sessionKey: string): void {
    if (this.env[STORE_PATH_ENV]?.trim()) return;
    this.stopWatching();
    this.storePath = resolveStorePath(this.cwd, this.env, sessionKey);
    this.cached = emptyDocument();
    this.lastKnownRev = -1;
  }

  /** Last document read from disk, without hitting the filesystem. */
  get snapshot(): TaskDocument {
    return this.cached;
  }

  read(): TaskDocument {
    try {
      const raw = fs.readFileSync(this.storePath, UTF8_ENCODING);
      this.cached = normalizeDocument(JSON.parse(raw));
    } catch (error) {
      // A missing file is the normal state before the first write. Anything
      // else means the task list just silently became empty, which is worth a
      // record: unreadable or corrupt JSON looks identical to "no tasks yet".
      if ((error as NodeJS.ErrnoException).code !== MISSING_FILE_CODE) {
        this.report?.error(TASK_EVENT.storeReadFailed, error, { [STORE_PATH_ATTRIBUTE]: this.storePath });
      }
      this.cached = emptyDocument();
    }
    this.lastKnownRev = this.cached.rev;
    return this.cached;
  }

  async readAsync(shouldApply: () => boolean = () => true): Promise<TaskDocument> {
    const storePath = this.storePath;
    const document = await this.readDocumentAsync(storePath);
    if (!shouldApply()) return document;
    this.cached = document;
    this.lastKnownRev = document.rev;
    return document;
  }

  private async readDocumentAsync(storePath: string = this.storePath): Promise<TaskDocument> {
    try {
      const raw = await fs.promises.readFile(storePath, UTF8_ENCODING);
      return normalizeDocument(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== MISSING_FILE_CODE) {
        this.report?.error(TASK_EVENT.storeReadFailed, error, { [STORE_PATH_ATTRIBUTE]: storePath });
      }
      return emptyDocument();
    }
  }

  /**
   * Apply a mutation under the store lock.
   *
   * `mutate` receives the freshest on-disk document and returns either the next
   * document to commit or `undefined` for a read-only action (list/get), which
   * skips the write entirely so queries never bump `rev`.
   */
  async mutate<T>(
    mutate: (document: TaskDocument) => { document?: TaskDocument; value: T },
  ): Promise<{ document: TaskDocument; value: T }> {
    const release = await this.acquireLock();
    const outcome = (() => {
      try {
        const current = this.read();
        const mutation = mutate(current);
        if (!mutation.document) {
          return { result: { document: current, value: mutation.value } };
        }
        const committed = this.write(mutation.document);
        return {
          result: { document: committed, value: mutation.value },
          notification: { previous: current, committed },
        };
      } finally {
        release();
      }
    })();
    if (outcome.notification) {
      this.notifyCommitted(outcome.notification.previous, outcome.notification.committed);
    }
    return outcome.result;
  }

  private notifyCommitted(previous: TaskDocument, committed: TaskDocument): void {
    try {
      this.onCommitted?.(previous, committed);
    } catch (error) {
      this.report?.error(TASK_EVENT.storeCommitListenerFailed, error, { [STORE_PATH_ATTRIBUTE]: this.storePath });
    }
  }

  private write(document: TaskDocument): TaskDocument {
    const next: TaskDocument = { ...document, version: STORE_SCHEMA_VERSION, rev: document.rev + 1 };
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temp = tempPathFor(this.storePath);
    fs.writeFileSync(temp, `${JSON.stringify(next, undefined, 2)}\n`, UTF8_ENCODING);
    fs.renameSync(temp, this.storePath);
    this.cached = next;
    this.lastKnownRev = next.rev;
    return next;
  }

  private async acquireLock(): Promise<() => void> {
    const lockPath = lockPathFor(this.storePath);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;

    for (;;) {
      try {
        const handle = fs.openSync(lockPath, 'wx');
        fs.writeSync(handle, JSON.stringify({ pid: process.pid, time: Date.now() }));
        fs.closeSync(handle);
        return () => fs.rmSync(lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== LOCK_EXISTS_CODE) throw error;
        // The deadline is checked before breaking a stale lock so a peer that
        // keeps recreating one cannot spin this loop without bound.
        if (Date.now() >= deadline) {
          // Proceeding lock-free beats stalling the agent: the rename is atomic,
          // so the worst case is a lost concurrent update, not a corrupt file.
          // Reported because a lost update here can strand a delegation.
          this.report?.warn(
            TASK_EVENT.storeLockTimeout,
            new Error(`Task store lock still held after ${this.lockTimeoutMs}ms; proceeding without it`),
            { [STORE_PATH_ATTRIBUTE]: this.storePath },
          );
          return () => {};
        }
        // Clearing a dead holder's lock still goes through the backoff. Yielding
        // on every iteration is what stops a peer that keeps recreating the
        // lock from turning this into a spin.
        this.breakStaleLock(lockPath);
        await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_MAX_MS);
      }
    }
  }

  /** Remove a lock left behind by a dead process or one held implausibly long. */
  private breakStaleLock(lockPath: string): boolean {
    try {
      const holder = JSON.parse(fs.readFileSync(lockPath, UTF8_ENCODING)) as { pid?: number; time?: number };
      const expired = typeof holder.time === 'number' && Date.now() - holder.time > LOCK_STALE_MS;
      const dead = typeof holder.pid === 'number' && !isProcessAlive(holder.pid);
      if (!expired && !dead) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      // Losing the race to another breaker is normal; a persistent failure here
      // shows up as the lock timeout above, so this stays a warning.
      if ((error as NodeJS.ErrnoException).code !== MISSING_FILE_CODE) {
        this.report?.warn(TASK_EVENT.storeLockBreakFailed, error, { [STORE_PATH_ATTRIBUTE]: lockPath });
      }
      return false;
    }
  }

  /**
   * Notify when another process changes the store.
   *
   * `fs.watch` alone is unreliable across the rename-based write (and on some
   * network filesystems), so a slow poll backs it up. Writes made by this
   * process are filtered out by revision so the UI does not redraw twice.
   */
  onExternalChange(listener: (document: TaskDocument) => void): () => void {
    this.listeners.add(listener);
    this.startWatching();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  private startWatching(): void {
    if (this.watcher || this.pollTimer) return;
    this.watchGeneration += 1;
    const directory = path.dirname(this.storePath);
    const fileName = path.basename(this.storePath);

    try {
      fs.mkdirSync(directory, { recursive: true });
      this.watcher = fs.watch(directory, (_event, changed) => {
        if (changed && changed !== fileName) return;
        this.scheduleCheck();
      });
    } catch (error) {
      // Polling still covers change detection, just more slowly.
      this.report?.warn(TASK_EVENT.storeWatchFailed, error, { [STORE_PATH_ATTRIBUTE]: this.storePath });
    }

    this.pollTimer = setInterval(() => this.queueChangeCheck(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private scheduleCheck(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.queueChangeCheck(), WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private queueChangeCheck(): void {
    if (this.checkInFlight) {
      this.checkQueued = true;
      return;
    }
    const generation = this.watchGeneration;
    const execution = (async () => {
      do {
        this.checkQueued = false;
        await this.checkForChange(generation);
      } while (this.checkQueued && generation === this.watchGeneration);
    })().finally(() => {
      if (this.checkInFlight === execution) this.checkInFlight = undefined;
    });
    this.checkInFlight = execution;
  }

  private async checkForChange(generation: number): Promise<void> {
    const previousRev = this.lastKnownRev;
    const document = await this.readDocumentAsync();
    if (generation !== this.watchGeneration) return;
    if (this.lastKnownRev !== previousRev) {
      this.checkQueued = true;
      return;
    }
    this.cached = document;
    this.lastKnownRev = document.rev;
    if (document.rev === previousRev) return;
    for (const listener of this.listeners) {
      try {
        listener(document);
      } catch (error) {
        // This runs from a timer and from the fs.watch callback, so an
        // unguarded listener throw is an uncaught exception that takes the
        // harness down rather than a handled render failure.
        this.report?.error(TASK_EVENT.storeListenerFailed, error, { [STORE_PATH_ATTRIBUTE]: this.storePath });
      }
    }
  }

  private stopWatching(): void {
    this.watchGeneration += 1;
    this.checkQueued = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  dispose(): void {
    this.listeners.clear();
    this.stopWatching();
  }
}
