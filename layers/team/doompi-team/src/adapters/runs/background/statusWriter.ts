/**
 * Coalesced writer for a run's `status.json`.
 *
 * WHY THIS EXISTS:
 * In the predecessor (`doom-pi-subagents/src/runs/background/subagent-runner.ts`)
 * `status.json` was rewritten in full on every child event, and every rewrite
 * `structuredClone`d the whole run graph first. On a fan-out run that makes the
 * hot path quadratic: N events cost O(N) clones of an O(N)-sized graph. Its
 * `recentTools` and `recentOutput` arrays were also appended to and never
 * trimmed, so a long run's status file, and the cost of cloning it, grew
 * without bound.
 *
 * DESIGN PATTERNS:
 * - Coalescing: `update()` mutates the in-memory status and arms a trailing
 *   ~75ms timer. A burst of events inside that window costs one clone and one
 *   write, not one per event
 * - The clone is gated by a dirty counter, not by the timer firing. A flush
 *   with nothing dirty since the last one performs no clone and no write at
 *   all, which is the specific fix for the quadratic behaviour above
 * - `updateSync()` bypasses the timer for transitions that must not be lost if
 *   the process dies right after: terminal run status, and chain step
 *   transitions. Everything else can wait out the coalescing window
 * - `recentTools` and `recentOutput` are capped at 50 entries, oldest dropped,
 *   on every append, so neither the in-memory status nor the cloned snapshot
 *   grows across a long run
 *
 * SINGLE WRITER CONTRACT (read this before adding another write site):
 * `CoalescedStatusWriter` is the ONLY thing in this package that may write
 * `status.json`. Not "the preferred way" - the only way. The predecessor had
 * four unsynchronised writers to the same file, which is exactly how a run's
 * displayed status ends up torn, stale, or overwritten by a slower writer
 * racing a faster one; coalescing a single in-memory owner is what makes that
 * class of bug structurally impossible instead of merely unlikely.
 *
 * Anything else that wants to influence a run's displayed status - pause a
 * step, request a steer, ask a run to stop, report progress from a different
 * process than the one that called `open()` - must NOT open or write
 * `status.json` directly. It writes a sidecar/intent file instead, and the
 * process holding this writer observes that file and folds it into its own
 * `update()`. Readers for those intent files do not exist yet; that is a gap
 * to fill, not a license to reach for `writeAtomicJson(statusPath, ...)`
 * somewhere else. If you are about to write `status.json` from outside this
 * class, stop - that is the bug this module exists to remove.
 *
 * AVOID:
 * - Reading back `status.json` from disk to decide what to write next; the
 *   in-memory status held by `open()` is the only source of truth this class
 *   trusts
 * - Adding a second writer of `status.json` anywhere else in the package,
 *   including "just this once" debug or recovery code
 */

import * as path from 'node:path';

import { writeAtomicJson } from '../../atomicJson';
import { currentRunsDir } from '../../filesystem/paths';

/** How long a burst of updates may be buffered before a trailing flush. */
const DEFAULT_FLUSH_INTERVAL_MS = 75;

/** Oldest-dropped cap for `recentTools` and `recentOutput`. */
const MAX_RECENT_ENTRIES = 50;

/**
 * The one status filename.
 *
 * Exported because the reconciler and the steering reader both have to find
 * this file without going through the writer. Two modules matching a literal
 * by eye is how a rename silently orphans a reader.
 */
export const STATUS_FILE_NAME = 'status.json';

/**
 * The minimum shape this writer needs to know about. Everything else in a
 * concrete run's status is opaque to it: capping `recentTools` and
 * `recentOutput` is the one piece of run semantics this module owns, because
 * it is the specific fix for the unbounded-growth bug above.
 */
export interface StatusWithRecentEntries {
  recentTools?: unknown[];
  recentOutput?: unknown[];
}

export interface CoalescedStatusWriterContract<TStatus extends StatusWithRecentEntries = StatusWithRecentEntries> {
  /**
   * Start tracking a run's status and write it once, synchronously, so the
   * file exists before the caller does anything else.
   *
   * Calling this again, on the same or a different `runId`, is a reset, not
   * an error: it discards whatever was previously tracked, including any
   * mutation buffered by `update()` that had not flushed yet, cancels the
   * pending coalescing timer, and starts a fresh session against the new
   * status. This is deliberate so a runner that retries a bootstrap step can
   * just call `open()` again rather than having to detect and recover from a
   * half-initialized writer.
   */
  open(runId: string, initialStatus: TStatus): void;
  /** Apply an in-memory mutation and let the trailing timer coalesce the write. */
  update(mutator: (status: TStatus) => void): void;
  /** Apply an in-memory mutation and flush synchronously, for transitions that must survive a crash. */
  updateSync(mutator: (status: TStatus) => void): void;
  /** Append one entry to `recentTools`, capped at 50, coalesced like `update()`. */
  appendTool(entry: unknown): void;
  /** Append one entry to `recentOutput`, capped at 50, coalesced like `update()`. */
  appendOutput(entry: unknown): void;
  /** Cancel any pending timer and flush whatever is dirty. Safe to call more than once. */
  close(): void;
}

export class CoalescedStatusWriter<
  TStatus extends StatusWithRecentEntries = StatusWithRecentEntries,
> implements CoalescedStatusWriterContract<TStatus> {
  /**
   * Runtime tuning seam for tests, kept out of the dependency constructor. A
   * test subclass overrides this to avoid waiting
   * out the real window when it does exercise the timer directly instead of
   * using fake timers.
   */
  protected readonly flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS;

  private statusPath: string | undefined;
  private status: TStatus | undefined;
  private dirtyCount = 0;
  private flushTimer: NodeJS.Timeout | undefined;

  open(runId: string, initialStatus: TStatus): void {
    // A second open() is a reset: cancel whatever this instance was
    // previously tracking (including an unflushed dirty mutation) rather
    // than merging with it. See the doc comment on the interface method.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.statusPath = path.join(currentRunsDir(), runId, STATUS_FILE_NAME);
    this.status = initialStatus;
    this.dirtyCount = 0;
    // The initial write is not a coalescing candidate: callers rely on the
    // file existing as soon as `open()` returns, so it always goes straight
    // to disk rather than waiting for a timer.
    writeAtomicJson(this.statusPath, this.clone(initialStatus));
  }

  update(mutator: (status: TStatus) => void): void {
    mutator(this.requireStatus());
    this.dirtyCount++;
    this.scheduleFlush();
  }

  updateSync(mutator: (status: TStatus) => void): void {
    mutator(this.requireStatus());
    this.dirtyCount++;
    this.flush();
  }

  appendTool(entry: unknown): void {
    this.update((status) => appendCapped(status, 'recentTools', entry));
  }

  appendOutput(entry: unknown): void {
    this.update((status) => appendCapped(status, 'recentOutput', entry));
  }

  close(): void {
    this.flush();
  }

  /**
   * The clone-and-write step. Protected so a test can override `clone()`
   * alone and assert it was never called across a run of no-op flushes,
   * which is the direct, observable proof that the dirty-counter gate works.
   */
  protected clone<T>(value: T): T {
    return structuredClone(value);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirtyCount === 0) return;
    const status = this.status;
    const statusPath = this.statusPath;
    if (!status || !statusPath) return;
    const snapshot = this.clone(status);
    this.dirtyCount = 0;
    writeAtomicJson(statusPath, snapshot);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const timer = setTimeout(() => this.flush(), this.flushIntervalMs);
    // A pending flush timer must never be the reason the process stays alive.
    timer.unref?.();
    this.flushTimer = timer;
  }

  private requireStatus(): TStatus {
    if (!this.status) throw new Error('CoalescedStatusWriter used before open().');
    return this.status;
  }
}

/** Push `entry` onto `status[field]`, dropping the oldest until at most 50 remain. */
function appendCapped(status: StatusWithRecentEntries, field: 'recentTools' | 'recentOutput', entry: unknown): void {
  const list = status[field] ?? [];
  list.push(entry);
  if (list.length > MAX_RECENT_ENTRIES) list.splice(0, list.length - MAX_RECENT_ENTRIES);
  status[field] = list;
}
