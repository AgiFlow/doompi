/**
 * Blocks a turn until one or more tracked async runs finish, need attention,
 * or a timeout elapses - resolving with a status snapshot every time.
 *
 * WHY THIS IS A REDESIGN, NOT A PORT:
 * `doom-pi-subagents/src/runs/background/subagentWait.ts` is 686 lines
 * because it also waits on remembered detached FOREGROUND runs (reading
 * child transcripts byte-range-tailed off disk to render a live preview) and
 * session-scoped background-work PROVIDER items (a separate registration
 * protocol with its own wake channels), on top of async runs. This package is
 * async-only - there is no foreground run mode, and no provider protocol has
 * been ported (see `spawnHandshake.ts`'s header for the same "async-only"
 * framing applied elsewhere). Waiting on either would be dead code with
 * nothing to ever populate it. Only the async-run wait survives, rebuilt
 * against what this package actually has.
 *
 * COMPOSITION, NOT REIMPLEMENTATION:
 * `status.json` has one writer (`CoalescedStatusWriter`) and several
 * legitimate readers; this module is not a new one. It reads run state
 * exclusively through `AsyncJobTracker`, which already owns the poll-and-cache
 * loop against `status.json` (`PollScheduler`-driven, per its own header).
 * `wait()` never touches `node:fs` and registers no `PollScheduler`
 * subscription of its own - see "WHY A PRIVATE POLL LOOP" below for why it
 * still owns a short-lived timer despite that.
 *
 * TARGET SHAPE - `{ id } | { ids } | { all: true }`:
 * One run, several, or every run `AsyncJobTracker` currently has tracked
 * (`list()` IS that set - whatever the run's own spawn path called `track()`
 * for is what "outstanding" means here; this module does not independently
 * decide what counts as outstanding). An `id`/`ids` entry not yet tracked is
 * tracked on the caller's behalf, mirroring `track()`'s own idempotent-refresh
 * contract, so a caller does not have to track before it can wait.
 *
 * RETURN-ON-FIRST, NOT WAIT-FOR-ALL:
 * `wait()` resolves the moment ANY targeted run satisfies `waitFor`, not once
 * every targeted run does. This is a deliberate judgement call, not something
 * spelled out in the brief, and it is the more expressive of the two shapes:
 * wait-for-all composes out of return-on-first (call `wait()` again for
 * whatever remains in `WaitOutcome.runs` that has not yet satisfied
 * `waitFor`), but the reverse does not hold - if wait-for-all were the
 * primitive, a caller that wants the NEXT completion (the predecessor's own
 * rolling-replacement fleet-manager loop: wait for one, spawn its
 * replacement, wait again) could only get it by polling. Choosing the shape
 * that does not foreclose the other is why this is return-on-first rather
 * than a use case that happened to need it; the fleet-manager loop is
 * evidence the choice is usable, not the reason for it. If a real caller
 * turns up needing true wait-for-all-at-once as a single call, that is a
 * reason to add it later, built on top of this primitive.
 *
 * TIMEOUT IS A SNAPSHOT, NOT AN ERROR:
 * `wait()` always resolves; it never rejects for a mere timeout. Waiting
 * longer than asked is a normal outcome of an async system, and forcing every
 * caller into a `try`/`catch` for it is how a real error (a thrown bug) ends
 * up caught and swallowed right alongside it - the same reasoning
 * `SpawnHandshake`'s header gives for its own three-outcome, all-resolved
 * design. `WaitOutcome.reason` is `'timeout'`; the caller decides what to do
 * with `WaitOutcome.runs`, which is populated on every path, including this one.
 *
 * `'attention'` MUST WIN EARLY - THE POINT OF THIS INTERNAL SERVICE:
 * `DeliverableGuard.evaluate()` computes `activityState: 'needs_attention'`
 * and `reason: 'missing-deliverable'` after a failed nudge, but has no
 * standing to write `status.json` itself (see its own header). Once whatever
 * calls `evaluate()` folds that result into `status.json` through
 * `CoalescedStatusWriter` - the run's own runner main loop, not yet built -
 * `AsyncJobTracker` picks the fields up on its next poll (see that module's
 * own header note on this), and THIS module is what lets a caller that is
 * blocked in `wait()` ever find out, instead of only discovering it by
 * polling `subagent({ action: "status" })` in a loop. `waitFor: 'attention'`
 * returns the instant any targeted run's `activityState` is
 * `'needs_attention'`, before its timeout, before it would ever go terminal.
 * `waitFor: 'completion'` deliberately does the opposite - it waits THROUGH
 * attention, for a caller (an auto-drain loop) that wants to know about
 * results, not about a mid-flight nudge. `'any'` (the default) returns on
 * whichever comes first, matching the predecessor's default behaviour.
 *
 * WHY A PRIVATE POLL LOOP, NOT A SECOND `PollScheduler` SUBSCRIPTION:
 * `PollScheduler` is for long-lived subscribers that back off toward a shared
 * idle ceiling; `wait()` is the opposite shape, a short-lived, bounded call
 * that needs a TIGHT interval for its whole (short) life, the same reasoning
 * `SpawnHandshake`'s header gives for not registering with it either. The loop
 * here only ever reads `AsyncJobTracker`'s already-cached, in-memory state
 * (no `node:fs`, no disk I/O of its own), so polling it every
 * `pollIntervalMs` costs a handful of `Map` reads, not a filesystem round trip.
 *
 * WHY NO EVENT-BUS WAKE (dropped from the predecessor):
 * The predecessor wakes early on `pi.events` firing (an `ExtensionAPI` event
 * bus this package has not built) and otherwise falls back to a fixed poll.
 * With no bus to wake on, this module is poll-only - which is exactly the
 * fallback path the predecessor already had to support for when its own bus
 * was unavailable, so there is no new failure mode here, only a narrower one.
 *
 * AVOID:
 * - Reading `status.json` directly. If a field `wait()` needs is missing from
 *   `TrackedAsyncJob`, that is a reason to extend `AsyncJobTracker` (see its
 *   header's note on `activityState`/`attentionReason` for the last time this
 *   happened), not to open a second read path around it
 * - Treating a run id that was never tracked and has no readable `status.json`
 *   the same as one that is merely slow. `wait()` resolves `'no-active-runs'`
 *   immediately when NONE of the targeted ids ever resolve to a known status,
 *   rather than waiting out the full timeout on nothing
 */

import type { ActivityState } from '../../../types';
import type { AsyncJobTrackerContract, TrackedAsyncJobsContract } from '../../asyncJobTracker';

/** States `AsyncJobTracker` (mirroring `staleRunReconciler.ts`) treats as finished. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['complete', 'completed', 'failed', 'paused', 'stopped']);

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
export type WaitTarget = { id: string } | { ids: string[] } | { all: true };

export type WaitForMode = 'completion' | 'attention' | 'any';

export interface WaitRequest {
  target: WaitTarget;
  /** Pi context that owns the targeted run collection. */
  sessionId?: string;
  /** Defaults to `'any'`. */
  waitFor?: WaitForMode;
  /** Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Resolves early with `reason: 'aborted'` when this fires. */
  signal?: AbortSignal;
}

export type WaitReason = 'completed' | 'attention' | 'timeout' | 'aborted' | 'no-active-runs';

/** One targeted run's state at the moment `wait()` resolved. */
export interface WaitRunSnapshot {
  runId: string;
  /** `undefined` when this run has never had a readable `status.json`. */
  status: string | undefined;
  activityState?: ActivityState;
  /** Present alongside `activityState: 'needs_attention'`, e.g. `'missing-deliverable'`. */
  attentionReason?: string;
  error?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface WaitOutcome {
  reason: WaitReason;
  elapsedMs: number;
  /** Every targeted run's snapshot, regardless of `reason` - populated even on `'timeout'`. */
  runs: WaitRunSnapshot[];
}

export type SubagentWaiterContract = {
  wait(request: WaitRequest): Promise<WaitOutcome>;
};

function snapshotFrom(runId: string, job: ReturnType<TrackedAsyncJobsContract['get']>): WaitRunSnapshot {
  if (!job) return { runId, status: undefined };
  return {
    runId: job.runId,
    status: job.status,
    activityState: job.activityState,
    attentionReason: job.attentionReason,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

function isTerminal(snapshot: WaitRunSnapshot): boolean {
  return snapshot.status !== undefined && TERMINAL_STATES.has(snapshot.status);
}

function needsAttention(snapshot: WaitRunSnapshot): boolean {
  return snapshot.activityState === 'needs_attention';
}

function satisfies(snapshot: WaitRunSnapshot, waitFor: WaitForMode): boolean {
  if (waitFor === 'attention') return needsAttention(snapshot);
  if (waitFor === 'completion') return isTerminal(snapshot);
  return needsAttention(snapshot) || isTerminal(snapshot);
}

/** For `waitFor: 'any'` only: which condition actually satisfied it. Attention wins when both happen to be true, since it is the more actionable signal. */
function reasonFor(snapshot: WaitRunSnapshot): WaitReason {
  return needsAttention(snapshot) ? 'attention' : 'completed';
}

export class SubagentWaiter implements SubagentWaiterContract {
  constructor(private readonly tracker: AsyncJobTrackerContract) {}

  /**
   * Runtime tuning seams for tests, kept out of the dependency constructor.
   */
  protected readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  protected readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS;

  protected now(): number {
    return Date.now();
  }

  /** Sleep seam so a test can drive this with fake timers without a real delay. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  async wait(request: WaitRequest): Promise<WaitOutcome> {
    const startedAt = this.now();
    const timeoutMs =
      request.timeoutMs !== undefined && request.timeoutMs > 0 ? request.timeoutMs : this.defaultTimeoutMs;
    const waitFor = request.waitFor ?? 'any';

    const jobs = request.sessionId ? this.tracker.forSession(request.sessionId) : this.tracker;
    const runIds = this.resolveTargetIds(request.target, jobs);
    for (const runId of runIds) jobs.track(runId);

    const elapsed = (): number => this.now() - startedAt;
    const snapshotAll = (): WaitRunSnapshot[] => runIds.map((runId) => snapshotFrom(runId, jobs.get(runId)));

    if (runIds.length === 0) {
      return { reason: 'no-active-runs', elapsedMs: 0, runs: [] };
    }

    const initialRuns = snapshotAll();
    if (initialRuns.every((snapshot) => snapshot.status === undefined)) {
      return { reason: 'no-active-runs', elapsedMs: elapsed(), runs: initialRuns };
    }

    for (;;) {
      const runs = snapshotAll();
      const satisfied = runs.find((snapshot) => satisfies(snapshot, waitFor));
      if (satisfied) {
        // The label reflects what `waitFor` actually asked for, not merely
        // whatever the snapshot happens to carry: a run that is BOTH terminal
        // and (independently) still flagged needs_attention must still report
        // 'completed' for `waitFor: 'completion'`, since attention was never
        // part of what that mode was watching for.
        const reason: WaitReason =
          waitFor === 'completion' ? 'completed' : waitFor === 'attention' ? 'attention' : reasonFor(satisfied);
        return { reason, elapsedMs: elapsed(), runs };
      }
      if (request.signal?.aborted) {
        return { reason: 'aborted', elapsedMs: elapsed(), runs };
      }
      if (elapsed() >= timeoutMs) {
        return { reason: 'timeout', elapsedMs: elapsed(), runs };
      }
      await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, timeoutMs - elapsed())));
    }
  }

  private resolveTargetIds(target: WaitTarget, jobs: TrackedAsyncJobsContract): string[] {
    if ('id' in target) return [target.id];
    if ('ids' in target) return target.ids;
    return jobs.list().map((job) => job.runId);
  }
}
