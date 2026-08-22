/**
 * Watches `currentResultsDir()` for a run's terminal result and delivers each one to
 * a consumer exactly once.
 *
 * WHY THIS EXISTS:
 * The predecessor's watcher
 * (`doom-pi-subagents/src/runs/background/resultWatcher.ts`) had four
 * separate, verified bugs. This is a redesign around the fixes, not a line
 * port - the fixes below are structural, not patches on the old control flow.
 *
 * FIX 1 - WATCH BOTH 'rename' AND 'change':
 * The predecessor only reacted to `event === 'rename'` (`resultWatcher.ts:398-399`),
 * so a result file rewritten in place - same path, new contents, no
 * create/delete/rename - was never noticed until the poll safety net happened
 * to run. `watchResultsDir()` below reacts to any `fs.watch` callback whose
 * filename matches, regardless of `eventType`, the same way
 * `SpawnHandshake.watchDirectory` already does in this package.
 *
 * FIX 2 - TTL DEDUPE:
 * The predecessor re-implemented "is this a duplicate" inline at its call
 * site (`resultWatcher.ts:180-195`) *and* separately inside
 * `completion-dedupe.ts`'s `markSeenWithTtl`, so the check and the record used
 * two independently maintained copies of the same expiry logic. Every check
 * and every record here goes through `hasRecentlyDelivered()` and
 * `markDelivered()` and nothing else - one implementation of the TTL policy,
 * used the same way on both sides.
 *
 * FIX 3 - TIMER TYPES:
 * The predecessor stored `setTimeout`'s return value in fields typed (or
 * used) as if they were numbers (`resultWatcher.ts:361,371,425`), which only
 * happens to work under Node's `setTimeout` and breaks the moment the return
 * value is compared, serialized, or ported somewhere `setTimeout` returns a
 * number (browsers, some polyfills). This module does not own a timer at all:
 * `fs.watch` is the fast path and `PollScheduler` is the bounded safety net
 * (see fix 5), so there is no `Timeout` handle here for the compiler to get
 * wrong in the first place.
 *
 * FIX 4 - ATOMIC CONSUME (TOCTOU):
 * The predecessor checked a result file's existence, then unlinked it, as two
 * separate steps (`resultWatcher.ts:184-194,324-332`), racing any other
 * reader of the same file between the two. Here, the *first* thing that
 * happens to a candidate result is an attempted rename into
 * `currentRunsDir()/<runId>/claimed-result.json` (`claimResult()`). A successful
 * rename is exclusive ownership: nothing else can also be holding that
 * result, because there is only ever one file at the source path and only one
 * caller's `renameSync` can move it. A failed rename (source already gone)
 * means another claimer got there first, which is `claimResult()`'s normal,
 * expected return of `false` - not a caught error.
 *
 * FIX 5 - WATCH-FIRST, POLL AS A BOUNDED SAFETY NET:
 * `start()` registers with `PollScheduler` instead of owning a timer, the
 * same pattern as every other long-lived background subscriber in this
 * directory. `fs.watch` gives low latency; the scheduler's tick is the bound
 * on how late a check can ever be on a platform or mount where watches are
 * unreliable. Neither path is trusted alone.
 *
 * DESIGN PATTERNS:
 * - A claimed result lives at `currentRunsDir()/<runId>/claimed-result.json`, inside
 *   the run's own working directory rather than a subdirectory of
 *   `currentResultsDir()`. Putting it under `currentResultsDir()` would make our own claims
 *   visible to the very `fs.watch` this module registers, and would risk
 *   colliding with `currentResultsDir()/<runId>.json` naming. `currentRunsDir()/<runId>/` is
 *   already this run's own directory (see `statusWriter.ts`,
 *   `terminalPersistence.ts`), so this reuses existing per-run space instead
 *   of inventing a second one
 * - `run()` uses promise-based filesystem operations and is awaited by
 *   `PollScheduler`; delivery remains independently asynchronous, and a
 *   claim's `inFlight` flag stops it from being re-fired on the next tick
 *   while the previous attempt is still outstanding
 * - `run()` reports "work happened" only when it claimed a new file, not when
 *   it merely retried a still-pending delivery. A consumer that keeps
 *   rejecting the same result forever would otherwise pin the scheduler's
 *   backoff at the floor indefinitely
 * - A crash between claiming a result and delivering it leaves
 *   `claimed-result.json` on disk with nothing tracking it in memory.
 *   `start()` scans for these once, so a fresh process picks up an
 *   interrupted delivery instead of leaving it stranded forever
 *
 * AVOID:
 * - Reading or unlinking anything at `currentResultsDir()/<runId>.json` once
 *   `claimResult()` has returned true for it; ownership has moved to the
 *   claimed copy, and the source name may already belong to an unrelated,
 *   later result
 * - Treating a rename failure from `claimResult()` as noteworthy; the
 *   `onProcessingError` path is for delivery failures and parse failures, not
 *   for the ordinary case of losing a claim race
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWatchPath } from './filesystem/configDir';
import { currentResultsDir, currentRunsDir } from './filesystem/paths';
import type { PollSchedulerContract } from './pollScheduler';
import { SUBAGENT_RUN_ID_ENV } from '../types/environment';

/** Suffix a candidate result file must have in `currentResultsDir()`. */
export const RESULT_FILE_SUFFIX = '.json';
/** Leaf name of a claimed result inside `currentRunsDir()/<runId>/`. */
export const CLAIMED_RESULT_FILE_NAME = 'claimed-result.json';

/** Poll safety-net cadence, generously looser than `fs.watch`'s latency (see `PollScheduler`'s header). */
const DEFAULT_POLL_INTERVAL_MS = 4_000;
/** How long a delivered run id is remembered, so a re-appearing result for it is dropped instead of redelivered. */
const DEFAULT_DEDUPE_TTL_MS = 60_000;
/** Cap on tracked delivered ids, so a very long session cannot grow this without bound. */
const MAX_TRACKED_DELIVERIES = 256;

const POLL_SUBSCRIBER_ID = 'result-watcher';

/** The parsed contents of a result file, with `runId` guaranteed present. */
export interface RunResultFile {
  runId: string;
  [key: string]: unknown;
}

/**
 * Handles one delivered result. Returns (or resolves to) `true` once it has
 * been durably accepted, which is what lets the claimed copy be removed;
 * `false` means "not yet", and the same claim is retried on a later tick.
 */
export type ResultConsumer = (result: RunResultFile) => boolean | Promise<boolean>;

export type ResultWatcherContract = {
  /** Begin watching. Calling this again resets whatever was previously tracked, same as `CoalescedStatusWriter.open`. */
  start(consumer: ResultConsumer): void;
  /** Stop watching, unregister from the scheduler, and drop all in-memory state. */
  stop(): void;
};

interface ClaimEntry {
  /** True while `deliverClaim()` is awaiting this claim's consumer call, so `run()` does not fire it twice. */
  inFlight: boolean;
}

function resultPathFor(file: string): string {
  return path.join(currentResultsDir(), file);
}

function runDirFor(runId: string): string {
  return path.join(currentRunsDir(), runId);
}

function claimPathFor(runId: string): string {
  return path.join(runDirFor(runId), CLAIMED_RESULT_FILE_NAME);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

export class ResultWatcher implements ResultWatcherContract {
  constructor(private readonly scheduler: PollSchedulerContract) {}

  /**
   * Runtime tuning seams for tests, kept out of the dependency constructor.
   */
  protected readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  protected readonly dedupeTtlMs: number = DEFAULT_DEDUPE_TTL_MS;

  protected now(): number {
    return Date.now();
  }

  /** Records a claim or delivery failure. Overridable; never a stdio write (see package rules). */
  protected onProcessingError(id: string, error: unknown): void {
    this.lastProcessingError = { id, error, at: this.now() };
    this.processingErrorCount += 1;
  }

  /** The most recent processing failure, for diagnostics. */
  lastProcessingError: { id: string; error: unknown; at: number } | undefined;
  /** How many processing failures this watcher has absorbed. */
  processingErrorCount = 0;

  private consumer: ResultConsumer | undefined;
  private watcher: fs.FSWatcher | undefined;
  private unregisterPoll: (() => void) | undefined;
  private readonly claims = new Map<string, ClaimEntry>();
  private readonly deliveredAt = new Map<string, number>();
  private generation = 0;
  private initializedGeneration = -1;

  // ---------------------------------------------------------------------
  // Filesystem seams. ESM module namespaces are frozen (`vi.spyOn(fs, ...)`
  // throws), so every `node:fs` call a test needs to redirect is wrapped here.
  // ---------------------------------------------------------------------

  protected listResultFiles(): string[] {
    try {
      return fs.readdirSync(currentResultsDir()).filter((entry) => entry.endsWith(RESULT_FILE_SUFFIX));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Run ids with a lingering claimed copy, found by scanning `currentRunsDir()` once at `start()`. */
  protected listClaimedRunIds(): string[] {
    try {
      return fs
        .readdirSync(currentRunsDir())
        .filter((entry) => this.fileExists(path.join(runDirFor(entry), CLAIMED_RESULT_FILE_NAME)));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  protected async listResultFilesAsync(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(currentResultsDir());
      return entries.filter((entry) => entry.endsWith(RESULT_FILE_SUFFIX));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  protected async listClaimedRunIdsAsync(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(currentRunsDir());
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const existing = await Promise.all(
      entries.map((entry) => this.fileExistsAsync(path.join(runDirFor(entry), CLAIMED_RESULT_FILE_NAME))),
    );
    return entries.filter((_entry, index) => existing[index]);
  }

  protected fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  protected readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  protected ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  /**
   * The atomic claim (fix 4). Returns `false`, without throwing, when the
   * source is already gone - another claimer won the race, which is the
   * expected outcome of two watchers noticing the same file.
   */
  protected renameFile(fromPath: string, toPath: string): boolean {
    try {
      fs.renameSync(fromPath, toPath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  protected unlinkFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (!isNotFound(error)) this.onProcessingError(filePath, error);
    }
  }

  protected async fileExistsAsync(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  protected async readFileAsync(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  protected async ensureDirAsync(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  protected async renameFileAsync(fromPath: string, toPath: string): Promise<boolean> {
    try {
      await fs.promises.rename(fromPath, toPath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  protected async unlinkFileAsync(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (!isNotFound(error)) this.onProcessingError(filePath, error);
    }
  }

  /**
   * The `fs.watch` callback's logic, factored out so it can be exercised
   * deterministically (fix 1's actual test coverage): calling this directly
   * with synthetic `eventType`/`filename` values proves the filter reacts to
   * 'change' exactly like 'rename', without depending on whether - or when -
   * the OS actually delivers a real filesystem event. `fs.watch` gives no
   * delivery guarantee at all, so a test that waits on a real one to arrive
   * is testing the OS's scheduler, not this code; see `watchResultsDir()`'s
   * only caller of this, and the poll safety net (fix 5) that exists
   * precisely because that guarantee does not hold.
   */
  protected handleWatchEvent(_eventType: fs.WatchEventType, filename: string | Buffer | null): void {
    if (!filename) return;
    if (!filename.toString().endsWith(RESULT_FILE_SUFFIX)) return;
    this.scheduler.wake();
  }

  /**
   * A watch that has emitted 'error' is treated as gone: `run()` checks
   * `getWatcher()` on its next tick and re-establishes it, falling back to
   * the poll safety net (fix 5) in the meantime. Factored out, like
   * `handleWatchEvent`, so a test can trigger it directly rather than by
   * provoking a real watch failure.
   */
  protected handleWatchError(): void {
    this.watcher = undefined;
  }

  /** The currently-held watch, if any. Exposed for tests; `run()` reads the field directly. */
  protected getWatcher(): fs.FSWatcher | undefined {
    return this.watcher;
  }

  /**
   * Watch `currentResultsDir()` for candidate result files. Reacts to every `fs.watch`
   * callback regardless of `eventType` (fix 1, see `handleWatchEvent`).
   * Returns `undefined`, without throwing, when the watch could not be
   * established at all - `run()` retries this on its next tick, and the poll
   * safety net (fix 5) covers the gap in the meantime.
   */
  protected watchResultsDir(): fs.FSWatcher | undefined {
    try {
      this.ensureDir(currentResultsDir());
      const watchPath = resolveWatchPath(currentResultsDir(), fs.realpathSync.native);
      const watcher = fs.watch(watchPath, (eventType, filename) => this.handleWatchEvent(eventType, filename));
      watcher.on('error', () => this.handleWatchError());
      watcher.unref?.();
      return watcher;
    } catch {
      return undefined;
    }
  }

  protected async watchResultsDirAsync(): Promise<fs.FSWatcher | undefined> {
    try {
      await this.ensureDirAsync(currentResultsDir());
      let watchPath = currentResultsDir();
      try {
        watchPath = await fs.promises.realpath(watchPath);
      } catch {
        // Watching the unresolved path may still work on this platform.
      }
      const watcher = fs.watch(watchPath, (eventType, filename) => this.handleWatchEvent(eventType, filename));
      watcher.on('error', () => this.handleWatchError());
      watcher.unref?.();
      return watcher;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------
  // TTL dedupe (fix 2). One implementation, used by both the check and the
  // record, so they cannot drift the way the predecessor's two copies did.
  // ---------------------------------------------------------------------

  private pruneDeliveredAt(now: number): void {
    for (const [key, at] of this.deliveredAt) {
      if (now - at > this.dedupeTtlMs) this.deliveredAt.delete(key);
    }
  }

  private hasRecentlyDelivered(runId: string): boolean {
    const now = this.now();
    this.pruneDeliveredAt(now);
    return this.deliveredAt.has(runId);
  }

  private markDelivered(runId: string): void {
    const now = this.now();
    this.pruneDeliveredAt(now);
    this.deliveredAt.set(runId, now);
    if (this.deliveredAt.size > MAX_TRACKED_DELIVERIES) {
      const oldest = this.deliveredAt.keys().next();
      if (!oldest.done) this.deliveredAt.delete(oldest.value);
    }
  }

  // ---------------------------------------------------------------------
  // Claim + deliver
  // ---------------------------------------------------------------------

  /** Attempt the atomic claim for one candidate file. `true` only when this call won the race. */
  protected claimResult(runId: string, file: string): boolean {
    this.ensureDir(runDirFor(runId));
    return this.renameFile(resultPathFor(file), claimPathFor(runId));
  }

  protected async claimResultAsync(runId: string, file: string): Promise<boolean> {
    await this.ensureDirAsync(runDirFor(runId));
    return this.renameFileAsync(resultPathFor(file), claimPathFor(runId));
  }

  /** Claim every new candidate in `currentResultsDir()`. Returns how many were newly claimed. */
  private async discoverAndClaim(generation: number): Promise<number> {
    let claimedCount = 0;
    const ownRunId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
    for (const file of await this.listResultFilesAsync()) {
      if (generation !== this.generation) return claimedCount;
      const runId = file.slice(0, -RESULT_FILE_SUFFIX.length);
      // A nested-capable child loads the same Doom Team extension as its
      // parent. It must not claim the result for its own one-shot run.
      if (!runId || runId === ownRunId || this.claims.has(runId)) continue;
      if (await this.claimResultAsync(runId, file)) {
        if (generation !== this.generation) return claimedCount;
        this.claims.set(runId, { inFlight: false });
        claimedCount += 1;
      }
      // A `false` result means another claimer already took this file; that
      // is the normal outcome of a race, not an error (fix 4).
    }
    return claimedCount;
  }

  private async discardClaim(runId: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    await this.unlinkFileAsync(claimPathFor(runId));
    if (generation === this.generation) this.claims.delete(runId);
  }

  private async deliverClaim(runId: string, entry: ClaimEntry, generation: number): Promise<void> {
    const claimPath = claimPathFor(runId);
    try {
      const raw = await this.readFileAsync(claimPath);
      if (generation !== this.generation) return;
      if (raw === undefined) {
        // Claimed file vanished from under us (manual cleanup, disk issue);
        // nothing left to deliver.
        this.claims.delete(runId);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        this.onProcessingError(runId, error);
        await this.discardClaim(runId, generation);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        await this.discardClaim(runId, generation);
        return;
      }

      const parsedRecord = parsed as Record<string, unknown>;
      const resolvedRunId = typeof parsedRecord.runId === 'string' && parsedRecord.runId ? parsedRecord.runId : runId;
      if (this.hasRecentlyDelivered(resolvedRunId)) {
        // A duplicate write for a run we already delivered inside the TTL
        // window: dropped, not redelivered (fix 2).
        await this.discardClaim(runId, generation);
        return;
      }

      const consumer = this.consumer;
      if (!consumer) {
        // No subscriber yet (start() raced ahead of the caller wiring one
        // in); retry once one is registered.
        entry.inFlight = false;
        return;
      }

      const record: RunResultFile = { ...parsedRecord, runId: resolvedRunId };
      const accepted = await consumer(record);
      if (generation !== this.generation) return;
      if (accepted) {
        this.markDelivered(resolvedRunId);
        await this.discardClaim(runId, generation);
      } else {
        entry.inFlight = false;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.onProcessingError(runId, error);
      entry.inFlight = false;
    }
  }

  /**
   * One scheduler tick. Filesystem discovery is awaited by `PollScheduler`;
   * consumer delivery remains independently asynchronous. Returns `true`
   * only when a new result was claimed this tick, so a consumer that keeps
   * saying "not yet" cannot pin the scheduler's backoff at the floor forever.
   */
  protected async run(): Promise<boolean> {
    const generation = this.generation;
    if (!this.watcher) this.watcher = await this.watchResultsDirAsync();
    if (generation !== this.generation) return false;

    if (this.initializedGeneration !== generation) {
      const claimedRunIds = await this.listClaimedRunIdsAsync();
      if (generation !== this.generation) return false;
      for (const runId of claimedRunIds) this.claims.set(runId, { inFlight: false });
      this.initializedGeneration = generation;
    }

    const claimedCount = await this.discoverAndClaim(generation);
    if (generation !== this.generation) return false;

    for (const [runId, entry] of this.claims) {
      if (entry.inFlight) continue;
      entry.inFlight = true;
      void this.deliverClaim(runId, entry, generation);
    }

    return claimedCount > 0;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  start(consumer: ResultConsumer): void {
    // A second start() is a reset, the same idiom as CoalescedStatusWriter.open().
    this.stop();
    this.consumer = consumer;
    this.unregisterPoll = this.scheduler.register({
      id: POLL_SUBSCRIBER_ID,
      intervalMs: this.pollIntervalMs,
      run: () => this.run(),
    });
    this.scheduler.wake();
  }

  stop(): void {
    this.generation += 1;
    this.initializedGeneration = -1;
    this.consumer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.unregisterPoll?.();
    this.unregisterPoll = undefined;
    this.claims.clear();
    this.deliveredAt.clear();
  }
}
