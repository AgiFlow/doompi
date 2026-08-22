/**
 * Repairs a run's `status.json` from `running` to `failed` when, and only
 * when, its owning process is provably dead.
 *
 * WHY THIS EXISTS:
 * A runner process can die without ever reaching
 * `TerminalPersistenceService.finalize()` - `SIGKILL`, a host crash, an `OOM`
 * kill. `status.json` is then stuck reporting `running` forever: nothing else
 * in this package ever revisits it, because nothing else has a reason to.
 * This is that reason. It is read-only reconnaissance until it has actual
 * proof, and exactly one narrow write when it does.
 *
 * WHY THIS DOES NOT TOUCH THE RESULT FILE (the TOCTOU the predecessor had):
 * `doom-pi-subagents/src/runs/background/staleRunReconciler.ts:436-450`
 * checks `fs.existsSync(resultPath)`, then separately reads and parses that
 * same path to decide how to repair `status.json` from the result's content.
 * Between those two steps, `ResultWatcher.claimResult()` on the other side of
 * this same package can rename that exact path away as part of its own
 * atomic claim (`resultWatcher.ts`'s fix 4) - so the existence check and the
 * read do not necessarily observe the same file. This module never reads or
 * interprets a result file at all. It asks `RunIdResolver`, which already
 * knows about both the pending and the claimed location, only ONE question:
 * "does a result exist anywhere for this run yet, in either form?" If the
 * answer is yes, this module does nothing - a result existing at all means
 * the run finished, which is `ResultWatcher` and whatever consumes its
 * delivery's job to turn into a status update, not a staleness this module
 * needs to repair. This module only ever acts when NO result exists anywhere
 * and the owning process is provably gone, which is a state `ResultWatcher`
 * has no reason to ever contend for.
 *
 * WHY THIS NEVER CALLS `writeAtomicJson(statusPath, ...)`:
 * `CoalescedStatusWriter` is the only thing in this package permitted to write
 * `status.json` (see that module's header). This class is not exempt: a
 * repair opens its OWN, dedicated `CoalescedStatusWriter` instance - never the
 * process-wide singleton, which may simultaneously be the live write path for
 * a run this process is actually running - seeds it from the on-disk status
 * that was just read, and applies the repair through `updateSync()`, the same
 * as any other terminal transition in this package. The write is still, in
 * every observable way, `CoalescedStatusWriter` writing `status.json`; only
 * the instance's *lifetime* is scoped to this one repair.
 *
 * WHAT "PROVABLE" MEANS HERE:
 * Only `ProcessTerminalInspector.inspect()` returning `'crashed'` - an
 * OS-confirmed `ESRCH` on the crash marker's pid - authorizes a repair. The
 * predecessor also repaired a run whose pid was still alive (or unverifiable)
 * purely because `status.json` had not updated in 24 hours
 * (`staleAlivePidMs`). That branch is deliberately NOT ported: an
 * unresponsive-but-alive pid is still alive, and treating a long silence as
 * death is a guess, not proof. A run that is merely slow survives this module
 * untouched, by design.
 *
 * ORPHANED CLAIMS (steer-requests, append-requests, and any future queue):
 * `control-channel.ts` claims a queued steer request by renaming it to
 * `<name>.claim-<claimant>` before dispatch, then `commit()`s (deletes) it on
 * success or `release()`s (renames it back) on a throw. `chain-append.ts`
 * does the identical thing for append-requests. A hard kill between claim and
 * release leaves the `.claim-<claimant>` file behind with neither outcome
 * ever happening - the request just sits there, invisible, forever.
 * `sweepOrphanedClaims()` is the same kind of repair as `reconcile()`, for a
 * different piece of state: it puts every orphaned claim back under its
 * original queued name so the next scan retries it, on the same "provable
 * death, never a guess" standard.
 *
 * Per `port-steering`, confirmed against the actual code for both queues
 * separately rather than assumed to carry over from one to the other: the
 * two queues do NOT construct their queued filenames the same way (steer
 * zero-pads a timestamp and base64url-encodes an id; append uses a raw
 * `Date.now()` integer and a raw `randomUUID()`), but both still guarantee no
 * literal `.` before the trailing `.json`, so a last-occurrence split on
 * `.claim-` is unambiguous for either. For claimant identity: steer's only
 * production claimant is `` `${process.pid}-${randomUUID()}` ``, built by the
 * run's own runner process. Append-requests has no production claimant yet -
 * nothing in this package claims from it in production, only tests - so its
 * eventual format is undecided. What DOES hold for append-requests today,
 * independent of whatever claimant format is eventually chosen, is that
 * `append-requests/` lives under `currentRunsDir()/<runId>/`, scoped to exactly one
 * run, and nothing in this package's architecture has a reason for any
 * process other than that run's own runner to ever claim from its own queue.
 * So for every queue this module knows about, "is this claim orphaned" and
 * "is this run's owning process provably dead" are the same question,
 * answered by the same evidence - for steer-requests because of what its one
 * real claimant is, for append-requests because of what the directory can
 * structurally ever contain - which is why this method takes no claimant and
 * gates purely on `ProcessTerminalInspector.inspect(runId)` the same as
 * `reconcile()` does - once that says `'crashed'`, every claim under every
 * one of the run's claim-queue directories is orphaned, full stop; there is
 * nothing left to correlate a specific claim against.
 *
 * STRUCTURAL DISCOVERY, NOT A REGISTRY (revised from an earlier version of
 * this module that kept a `CLAIM_QUEUES` list of known queue directories):
 * A registry means a third queue added later is swept only if whoever adds it
 * remembers to add an entry here too - the exact "someone has to remember"
 * failure mode this whole feature exists to close for orphaned claims
 * themselves. So `sweepOrphanedClaims()` does not enumerate queues at all: it
 * walks every directory under the run's own folder (`currentRunsDir()/<runId>/`,
 * bounded by `MAX_CLAIM_SCAN_DEPTH` as insurance, not because any real queue
 * nests that deep) and recovers whatever it finds containing `.claim-`. A
 * queue added anywhere under a run's directory is covered from the day it
 * exists, with no change to this file.
 *
 * WHAT THIS GIVES UP, DELIBERATELY: there is no longer a single list a reader
 * can check to see "which queues does this module know about" - the queues
 * ARE whatever is on disk, discovered structurally. It also makes the
 * `.claim-<claimant>` suffix a load-bearing, package-wide contract rather
 * than an internal detail of `control-channel.ts` and `chain-append.ts`: any
 * future file under a run's directory whose name happens to contain that
 * substring is treated as an orphaned claim and unconditionally recovered by
 * stripping the suffix, on the assumption that anything shaped like this
 * package's one established claim-by-rename convention behaves like it. That
 * assumption held for both queues that exist today (see the `port-steering`
 * paragraph above) and is judged worth the coverage guarantee in exchange.
 *
 * `sweepOrphanedClaims()` is a separate public method rather than a step
 * folded into `reconcile()`, because it has an independent gating condition
 * (it is not related to `status.json`'s state, or to whether a result
 * exists) and an independent, testable outcome.
 *
 * AVOID:
 * - Synthesizing a status for a run whose `status.json` does not exist yet.
 *   `CoalescedStatusWriter.open()` writes it synchronously before returning
 *   (see that module's header), so a genuinely started run already has one by
 *   the time anything could observe it as missing; a missing file is either a
 *   run that has not started yet or an id that does not exist, and this
 *   module cannot tell those apart, so it reports nothing for either
 * - Treating `'unknown'` liveness the same as `'crashed'`; see
 *   `processTerminal.ts` for why they are kept distinct
 * - Parsing a pid out of a claimant string. It is `ControlChannelWatcher`'s
 *   implementation detail, not a documented wire format (`port-steering`'s
 *   own words); the crash marker is already the load-bearing evidence
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CoalescedStatusWriter,
  type CoalescedStatusWriterContract,
  STATUS_FILE_NAME,
  type StatusWithRecentEntries,
} from './runs/background/statusWriter';
import { appendJsonl } from './filesystem/artifacts';
import { currentRunsDir } from './filesystem/paths';
import { TERMINAL_ASYNC_JOB_STATES } from './asyncJobTracker';
import type { ProcessTerminalInspectorContract, ProcessTerminalVerdict } from './processTerminal';
import type { RunIdResolverContract } from './runIdResolver';

const EVENTS_FILE_NAME = 'events.jsonl';

/**
 * Matches `control-channel.ts`'s and `chain-append.ts`'s private
 * `CLAIM_SUFFIX_PREFIX` exactly (the two are identical to each other); not
 * exported from either module, and now the one thing that makes a directory
 * entry "a claim" for the purposes of the structural scan below.
 */
const CLAIM_SUFFIX_PREFIX = '.claim-';

/**
 * Insurance, not a modeled limit: no real claim queue nests anywhere near
 * this deep under a run's directory. Bounds `walkForClaims()` so a pathological
 * or symlink-cycle directory tree cannot make the scan unbounded.
 */
const MAX_CLAIM_SCAN_DEPTH = 8;

/**
 * The minimum shape this module reads and repairs. A run's actual status
 * carries far more than this - this package has not settled a shared status
 * type yet - so everything else on disk is preserved verbatim by round
 * tripping the whole parsed object through `open()`, never reconstructed here.
 */
export interface ReconcilableStatus extends StatusWithRecentEntries {
  runId?: string;
  state?: string;
  error?: string;
  startedAt?: number;
  lastUpdate?: number;
  endedAt?: number;
  [key: string]: unknown;
}

export interface ReconcileOutcome {
  repaired: boolean;
  /** Why nothing happened, or what was repaired - for logging, never parsed. */
  reason: string;
}

/** One orphaned claim recovered back to its original queued name. */
export interface RecoveredClaim {
  /**
   * The queue's directory, relative to the run's own directory and
   * forward-slash-normalized (e.g. `'append-requests'`, `'control/steer-requests'`).
   * Discovered structurally by `walkForClaims()`, not looked up in a registry.
   */
  queue: string;
  /** The original (recovered) filename, in that queue. */
  fileName: string;
}

export interface SweepOutcome {
  recovered: RecoveredClaim[];
}

/** Both repairs from one pass over a run. See `StaleRunReconcilerContract.reconcileAndSweep`. */
export interface ReconcileSweepOutcome {
  reconcile: ReconcileOutcome;
  sweep: SweepOutcome;
}

export type StaleRunReconcilerContract = {
  /** Repair `runId`'s status if, and only if, its process is provably dead. */
  reconcile(runId: string): ReconcileOutcome;
  /** Recover every one of `runId`'s orphaned claims, discovered structurally under its run directory, if and only if its process is provably dead. */
  sweepOrphanedClaims(runId: string): SweepOutcome;
  /**
   * Both repairs, sharing ONE `ProcessTerminalInspector.inspect()` call.
   *
   * Calling `reconcile()` and `sweepOrphanedClaims()` separately - which is
   * what the parent's poll subscriber used to do - inspects the same run
   * twice per tick, and each inspect is a crash-marker read, a JSON parse and
   * a `kill(pid, 0)`. Both gate on the identical question ("is this run's
   * owning process provably dead?"), so the second answer is always the first
   * answer; only the cost is new. For a healthy child, which is the
   * overwhelmingly common case, every bit of that work is discarded.
   *
   * The two methods stay public and independently callable: they have
   * genuinely independent gating conditions (see `sweepOrphanedClaims`'s own
   * doc) and independent tests. This is a shared-work wrapper over them, not
   * a replacement.
   *
   * The inspect is lazy and `reconcile`'s cheap file gates run before it, so
   * a terminal or already-delivered run never pays for liveness on the
   * reconcile side. It still pays once on the sweep side: orphaned claims are
   * gated on process death alone, deliberately independent of `status.json`
   * (see `sweepOrphanedClaims`), and folding them into the status gate would
   * quietly stop recovering claims for a run that finished. The guarantee here
   * is exactly one probe per pass, not zero.
   *
   * In practice the parent's subscriber skips terminal runs before calling
   * this at all, so that case costs nothing in the hot path either.
   */
  reconcileAndSweep(runId: string): ReconcileSweepOutcome;
  /** Promise-based reconciliation for the recurring parent poll subscriber. */
  reconcileAndSweepAsync?(runId: string): Promise<ReconcileSweepOutcome>;
};

function statusPathFor(runId: string): string {
  return path.join(currentRunsDir(), runId, STATUS_FILE_NAME);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class StaleRunReconciler implements StaleRunReconcilerContract {
  constructor(
    private readonly processTerminal: ProcessTerminalInspectorContract,
    private readonly runIdResolver: RunIdResolverContract,
  ) {}

  protected now(): number {
    return Date.now();
  }

  /**
   * A fresh writer per repair, deliberately never the container's singleton -
   * see the class doc for why sharing it would be unsafe. Protected so a test
   * can substitute a recording fake instead of touching disk.
   */
  protected createStatusWriter(): CoalescedStatusWriterContract<ReconcilableStatus> {
    return new CoalescedStatusWriter<ReconcilableStatus>();
  }

  protected readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  protected readStatus(runId: string): ReconcilableStatus | undefined {
    const raw = this.readFile(statusPathFor(runId));
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A status file mid-write (CoalescedStatusWriter's rename not yet
      // visible, or a torn read) is not evidence of anything; retried later.
      return undefined;
    }
    return isRecord(parsed) ? (parsed as ReconcilableStatus) : undefined;
  }

  protected async readStatusAsync(runId: string): Promise<ReconcilableStatus | undefined> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(statusPathFor(runId), 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return isRecord(parsed) ? (parsed as ReconcilableStatus) : undefined;
  }

  /** Best-effort diagnostic trail; a failing event log must never fail a repair. */
  protected appendEvent(runId: string, payload: object): void {
    try {
      appendJsonl(path.join(currentRunsDir(), runId, EVENTS_FILE_NAME), JSON.stringify(payload));
    } catch {
      // See method doc.
    }
  }

  /**
   * Walks `dir` and every subdirectory beneath it (bounded by
   * `MAX_CLAIM_SCAN_DEPTH`), returning every entry whose name contains
   * `.claim-`, wherever it is found. Replaces a flat, single-directory
   * listing keyed off a registry: see the class doc's "STRUCTURAL DISCOVERY"
   * section for why. Recursing only on `entry.isDirectory()` means a symlink
   * (`isSymbolicLink()`, not `isDirectory()`) is never followed, so this
   * needs no separate cycle-detection.
   */
  protected async appendEventAsync(runId: string, payload: object): Promise<void> {
    try {
      await fs.promises.appendFile(
        path.join(currentRunsDir(), runId, EVENTS_FILE_NAME),
        `${JSON.stringify(payload)}\n`,
      );
    } catch {
      // See method doc.
    }
  }

  protected walkForClaims(dir: string, depth = 0): Array<{ dir: string; name: string }> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }

    const found: Array<{ dir: string; name: string }> = [];
    for (const entry of entries) {
      if (entry.name.includes(CLAIM_SUFFIX_PREFIX)) {
        found.push({ dir, name: entry.name });
      } else if (entry.isDirectory() && depth < MAX_CLAIM_SCAN_DEPTH) {
        found.push(...this.walkForClaims(path.join(dir, entry.name), depth + 1));
      }
    }
    return found;
  }

  protected async walkForClaimsAsync(dir: string, depth = 0): Promise<Array<{ dir: string; name: string }>> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }

    const found: Array<{ dir: string; name: string }> = [];
    for (const entry of entries) {
      if (entry.name.includes(CLAIM_SUFFIX_PREFIX)) {
        found.push({ dir, name: entry.name });
      } else if (entry.isDirectory() && depth < MAX_CLAIM_SCAN_DEPTH) {
        found.push(...(await this.walkForClaimsAsync(path.join(dir, entry.name), depth + 1)));
      }
    }
    return found;
  }

  /**
   * Put a claimed file back under its original queued name. Returns `true`
   * only when the rename actually happened. Mirrors `control-channel.ts`'s
   * own `release()`: on any failure (original name occupied - astronomically
   * unlikely, the directory gone), there is nothing left to preserve by
   * retrying, so the orphaned claim is dropped rather than left unreachable.
   */
  protected recoverClaim(claimedPath: string, originalPath: string): boolean {
    try {
      fs.renameSync(claimedPath, originalPath);
      return true;
    } catch {
      try {
        fs.unlinkSync(claimedPath);
      } catch {
        // Best effort; see method doc.
      }
      return false;
    }
  }

  protected async recoverClaimAsync(claimedPath: string, originalPath: string): Promise<boolean> {
    try {
      await fs.promises.rename(claimedPath, originalPath);
      return true;
    } catch {
      try {
        await fs.promises.unlink(claimedPath);
      } catch {
        // Best effort; see method doc.
      }
      return false;
    }
  }

  /**
   * A memoizing wrapper over `inspect()`, so one tick's pair of repairs asks
   * the OS about a pid once instead of twice. Each public entry point makes
   * its own, so a standalone `reconcile()` still inspects exactly when it
   * always did.
   */
  private inspectOnce(runId: string): () => ReturnType<ProcessTerminalInspectorContract['inspect']> {
    let verdict: ReturnType<ProcessTerminalInspectorContract['inspect']> | undefined;
    return () => (verdict ??= this.processTerminal.inspect(runId));
  }

  reconcile(runId: string): ReconcileOutcome {
    return this.reconcileWith(runId, this.inspectOnce(runId));
  }

  sweepOrphanedClaims(runId: string): SweepOutcome {
    return this.sweepWith(runId, this.inspectOnce(runId));
  }

  reconcileAndSweep(runId: string): ReconcileSweepOutcome {
    const inspect = this.inspectOnce(runId);
    // Order matters: `reconcileWith` runs its cheap file gates before ever
    // calling `inspect`, so a terminal or already-delivered run pays nothing
    // extra here. Whichever of the two asks first funds the single call.
    return { reconcile: this.reconcileWith(runId, inspect), sweep: this.sweepWith(runId, inspect) };
  }

  async reconcileAndSweepAsync(runId: string): Promise<ReconcileSweepOutcome> {
    let verdict: ProcessTerminalVerdict | undefined;
    const inspect = async (): Promise<ProcessTerminalVerdict> => {
      if (verdict) return verdict;
      verdict = this.processTerminal.inspectAsync
        ? await this.processTerminal.inspectAsync(runId)
        : this.processTerminal.inspect(runId);
      return verdict;
    };
    const reconcile = await this.reconcileWithAsync(runId, inspect);
    const sweep = await this.sweepWithAsync(runId, inspect);
    return { reconcile, sweep };
  }

  private reconcileWith(
    runId: string,
    inspect: () => ReturnType<ProcessTerminalInspectorContract['inspect']>,
  ): ReconcileOutcome {
    const status = this.readStatus(runId);
    if (!status) return { repaired: false, reason: 'No status file for this run.' };

    const state = status.state;
    if (state !== undefined && TERMINAL_ASYNC_JOB_STATES.has(state)) {
      return { repaired: false, reason: `Run already terminal (${state}).` };
    }

    const location = this.runIdResolver.resolve(runId);
    if (location?.resultPath) {
      return { repaired: false, reason: "A result already exists; delivery is ResultWatcher's job, not a repair." };
    }

    const verdict = inspect();
    if (verdict.state !== 'crashed') {
      return {
        repaired: false,
        reason: `Owning process liveness is '${verdict.state}', which does not prove death; leaving the run as is.`,
      };
    }

    return this.repair(runId, status, verdict.marker.pid);
  }

  private async reconcileWithAsync(
    runId: string,
    inspect: () => Promise<ProcessTerminalVerdict>,
  ): Promise<ReconcileOutcome> {
    const status = await this.readStatusAsync(runId);
    if (!status) return { repaired: false, reason: 'No status file for this run.' };

    const state = status.state;
    if (state !== undefined && TERMINAL_ASYNC_JOB_STATES.has(state)) {
      return { repaired: false, reason: `Run already terminal (${state}).` };
    }

    const location = this.runIdResolver.resolveAsync
      ? await this.runIdResolver.resolveAsync(runId)
      : this.runIdResolver.resolve(runId);
    if (location?.resultPath) {
      return { repaired: false, reason: "A result already exists; delivery is ResultWatcher's job, not a repair." };
    }

    const verdict = await inspect();
    if (verdict.state !== 'crashed') {
      return {
        repaired: false,
        reason: `Owning process liveness is '${verdict.state}', which does not prove death; leaving the run as is.`,
      };
    }

    return this.repairAsync(runId, status, verdict.marker.pid);
  }

  private sweepWith(
    runId: string,
    inspect: () => ReturnType<ProcessTerminalInspectorContract['inspect']>,
  ): SweepOutcome {
    const verdict = inspect();
    if (verdict.state !== 'crashed') return { recovered: [] };

    const runDir = path.join(currentRunsDir(), runId);
    const recovered: RecoveredClaim[] = [];
    for (const { dir, name: entry } of this.walkForClaims(runDir)) {
      const claimIndex = entry.lastIndexOf(CLAIM_SUFFIX_PREFIX);
      // Filtered by walkForClaims() already; defensive, not reachable.
      if (claimIndex === -1) continue;
      const fileName = entry.slice(0, claimIndex);
      const wasRecovered = this.recoverClaim(path.join(dir, entry), path.join(dir, fileName));
      if (wasRecovered) {
        const queue = path.relative(runDir, dir).split(path.sep).join('/');
        recovered.push({ queue, fileName });
        this.appendEvent(runId, {
          type: 'subagent.run.claim_recovered',
          ts: this.now(),
          runId,
          pid: verdict.marker.pid,
          queue,
          recovered: fileName,
        });
      }
    }
    return { recovered };
  }

  private async sweepWithAsync(runId: string, inspect: () => Promise<ProcessTerminalVerdict>): Promise<SweepOutcome> {
    const verdict = await inspect();
    if (verdict.state !== 'crashed') return { recovered: [] };

    const runDir = path.join(currentRunsDir(), runId);
    const recovered: RecoveredClaim[] = [];

    for (const { dir, name: entry } of await this.walkForClaimsAsync(runDir)) {
      const claimIndex = entry.lastIndexOf(CLAIM_SUFFIX_PREFIX);
      if (claimIndex === -1) continue;
      const fileName = entry.slice(0, claimIndex);
      const wasRecovered = await this.recoverClaimAsync(path.join(dir, entry), path.join(dir, fileName));
      if (wasRecovered) {
        const queue = path.relative(runDir, dir).split(path.sep).join('/');
        recovered.push({ queue, fileName });
        await this.appendEventAsync(runId, {
          type: 'subagent.run.claim_recovered',
          ts: this.now(),
          runId,
          pid: verdict.marker.pid,
          queue,
          recovered: fileName,
        });
      }
    }
    return { recovered };
  }

  private repair(runId: string, status: ReconcilableStatus, deadPid: number): ReconcileOutcome {
    const now = this.now();
    const message = `Runner process ${deadPid} exited without finalizing this run. Marked failed by stale-run reconciliation.`;

    const writer = this.createStatusWriter();
    writer.open(runId, status);
    writer.updateSync((current) => {
      current.state = 'failed';
      current.error = current.error ?? message;
      current.lastUpdate = now;
      current.endedAt = current.endedAt ?? now;
    });

    this.appendEvent(runId, { type: 'subagent.run.repaired_stale', ts: now, runId, pid: deadPid, message });

    return { repaired: true, reason: message };
  }

  private async repairAsync(runId: string, status: ReconcilableStatus, deadPid: number): Promise<ReconcileOutcome> {
    const now = this.now();
    const message = `Runner process ${deadPid} exited without finalizing this run. Marked failed by stale-run reconciliation.`;

    const writer = this.createStatusWriter();
    writer.open(runId, status);
    writer.updateSync((current) => {
      current.state = 'failed';
      current.error = current.error ?? message;
      current.lastUpdate = now;
      current.endedAt = current.endedAt ?? now;
    });

    await this.appendEventAsync(runId, {
      type: 'subagent.run.repaired_stale',
      ts: now,
      runId,
      pid: deadPid,
      message,
    });

    return { repaired: true, reason: message };
  }
}
