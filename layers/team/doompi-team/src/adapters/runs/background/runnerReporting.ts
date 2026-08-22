/**
 * Owns the single, synchronous callback wired into
 * `TerminalPersistenceService.begin()`: it both finalizes the run's status
 * and writes the terminal result file `ResultWatcher` claims by rename.
 *
 * WHY BOTH WRITES LIVE IN ONE CALLBACK:
 * `TerminalPersistenceService`'s idempotency guarantee only covers what
 * happens inside that one callback - a second, independent write site for
 * the result file would be exactly the "fourth, unguarded terminal write"
 * shape that made the predecessor's finalization the worst bug in its
 * review (see `asyncExecution.ts`'s header for the full diagnosis). Putting
 * the result-file write here means it inherits the same at-most-once
 * guarantee the status write already has, from the same source, rather than
 * needing a second one invented for it.
 *
 * WRITE ORDER, DECIDED DELIBERATELY (status, then result):
 * - status terminal / result missing: `ResultWatcher` delivers nothing, and
 *   `StaleRunReconciler` sees no result plus a dead process, so it repairs.
 *   RECOVERABLE
 * - result present / status not terminal: `ResultWatcher` delivers, but
 *   `StaleRunReconciler` sees a result exists and correctly leaves the run
 *   alone (see that class's header), so the stale status persists forever.
 *   NOT RECOVERABLE
 * So status must land on disk first. The subtlety: `mutateTerminalStatus` is
 * the MUTATOR `TerminalPersistenceService` passes to
 * `CoalescedStatusWriter.updateSync(mutator)`, and that writer's own flush
 * only happens AFTER the mutator returns - so mutating `status` in place and
 * then writing the result file, in that order, inside this one function,
 * would put the result file on disk BEFORE the status flush, exactly
 * backwards. The fix: call `this.statusWriter.updateSync(() => {})` - a
 * second, no-op-mutator call to the SAME writer, re-entered from inside the
 * first one - immediately after mutating `status`. `updateSync` increments
 * its dirty counter and flushes unconditionally on every call regardless of
 * what its own mutator did, so this forces the just-mutated `status` onto
 * disk right there, before this function does anything else. The one
 * (harmless) cost is that `TerminalPersistenceService`'s own flush, once
 * this callback returns, then flushes again - a redundant but correct
 * second write of the same, already-correct status.
 *
 * WHY A THROW FROM THE RESULT WRITE CANNOT UNDO THE STATUS FLUSH:
 * The forced flush above happens, completes, and returns before
 * `writeResultFile` is even called - not "before it succeeds", before it is
 * INVOKED at all. A throw from that call propagates up through
 * `TerminalPersistenceService.triggerFinalize`'s `try` (skipping
 * `clearCrashMarker()`, per that class's own documented "leave the marker in
 * place" behavior on a mutator throw) into its `finally` (which still kills
 * tracked children) - but the status write already happened and cannot be
 * un-happened by anything that runs after it.
 *
 * WHY THE RESULT SHAPE IS MINIMAL, WITH ONE DELIBERATE EXCEPTION:
 * Most of the predecessor's ~40 result fields (structured output, artifacts,
 * workflow graph, capability audit) depend on subsystems not fully composed
 * here yet; shipping a correct minimal contract now beats an unverifiable
 * rich one. The exception: `acceptance` (an `AcceptanceLedger`) IS included
 * when `prepareResult()` was given one, because `acceptance.ts` is fully
 * ported and tested in this package today - an agent that declared
 * acceptance criteria and had them evaluated would otherwise produce a
 * result that silently omits the verdict, which is the same failure shape
 * as `DeliverableGuard`'s policy being unobservable (see
 * `asyncExecution.ts`'s header on that).
 *
 * WHY `summary` IS ALSO WRITTEN TO `status.json`, TRUNCATED:
 * Chain mode (`extensions/spawnPlan.ts`) needs a completed step's summary
 * to resolve the next step's `{previous}`/`{outputs.name}` template, but the
 * only thing that ever reads a delivered `RunResultFile` is whoever is
 * registered as `ResultWatcher`'s ONE consumer slot (`CompletionNotifier`,
 * by design). A second reader competing for that single claim-by-rename
 * would either displace the registered consumer or race it - both wrong.
 * `status.json` has no such problem: it has exactly one writer (this
 * callback, via `CoalescedStatusWriter`), is never claimed or unlinked, and
 * `AsyncJobTracker`/`SubagentWaiter` already read it to learn a run
 * finished - chain mode reads a step's summary through the path it already
 * uses. The copy in `status.json` is TRUNCATED (`MAX_STATUS_SUMMARY_CHARS`):
 * status is a coalesced, rewritten-in-full state file, not a log, and an
 * unbounded field there is a size problem waiting to happen. The full,
 * untruncated text still goes to the result file, for anything that reads
 * that instead. `acceptance` is deliberately NOT duplicated into status:
 * nothing this package builds yet gates chain advancement on an acceptance
 * verdict (only on execution success - see `spawnPlan.ts`'s header), so
 * there is no reader for a second copy of it yet. Add it if and when one
 * exists, the same reasoning as everything else flagged "not wired yet" in
 * this package.
 *
 * WHY `sessionFile` IS RECORDED HERE TOO, AND BOUNDED BY OMISSION, NOT
 * TRUNCATION:
 * `action='resume'` needs to know which Pi session transcript a completed
 * run's own child was writing to, and the CHILD is the only party that ever
 * knows that - `childTranscript.ts`'s header says the PARENT does not learn
 * a child's session id until the run ends, which already rules out the
 * parent recording it. `recordSessionFile()` is `prepareResult()`'s sibling:
 * a value set from outside, read back inside this same terminal-write
 * callback, on the SAME `CoalescedStatusWriter`, so it lands in the SAME
 * flush as everything else `mutateTerminalStatus` computes - no second
 * writer, no second flush. Where it is called from is
 * `subagentPromptRuntime.ts`'s `session_start` handler, the one place in
 * the child process that receives `ExtensionContext.sessionManager` at all.
 * `summary`'s bound is a truncation with a marker, because a shortened
 * summary is still a readable, honest summary. A shortened PATH is not a
 * smaller path to the same file - it is a WRONG path to some other file, or
 * no file at all, and `resume` acting on it would silently target the wrong
 * transcript. So this bound is "drop entirely past `MAX_SESSION_FILE_CHARS`,
 * never truncate" - the field goes missing rather than becoming a plausible-
 * looking lie an eventual `resume` implementation would trust.
 */

import * as path from 'node:path';
import { writeAtomicJson } from '../../atomicJson';
import { currentResultsDir } from '../../filesystem/paths';
import type { AcceptanceLedger } from '../../../types/runs';
import type { AsyncRunStatus } from './asyncExecution';
import { RESULT_FILE_SUFFIX, type RunResultFile } from '../../resultWatcher';
import { type CoalescedStatusWriterContract } from './statusWriter';
import type { TerminalTrigger } from './terminalPersistence';

function resultPathFor(runId: string): string {
  return path.join(currentResultsDir(), `${runId}${RESULT_FILE_SUFFIX}`);
}

/** Generous but bounded - see the module header's summary-in-status section. */
const MAX_STATUS_SUMMARY_CHARS = 4_000;
const TRUNCATION_MARKER = '\n... [truncated for status.json; see the result file for the full text]';

function truncateForStatus(summary: string): string {
  if (summary.length <= MAX_STATUS_SUMMARY_CHARS) return summary;
  return summary.slice(0, MAX_STATUS_SUMMARY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Generous for any real filesystem path; see the module header's `sessionFile` section for why exceeding this drops the field instead of truncating it. */
const MAX_SESSION_FILE_CHARS = 4_096;

/** What the run itself knows about its own outcome, recorded before a trigger fires. */
export interface RunnerResultInput {
  success: boolean;
  summary: string;
  /** Explicit terminal state for controlled outcomes such as an operator stop. */
  state?: 'completed' | 'failed' | 'stopped';
  acceptance?: AcceptanceLedger;
}

export type RunnerReportingContract = {
  /**
   * Record what to report if/when this run reaches a terminal state. Call
   * this before triggering finalize (normal completion, or right before an
   * interrupt/stop/timeout handler calls `terminalPersistence.finalize()`).
   * A trigger that fires with nothing prepared (a signal or exception mid-run)
   * still produces a result - see `mutateTerminalStatus`'s fallback.
   */
  prepareResult(input: RunnerResultInput): void;
  /**
   * Record this run's own Pi session transcript path, if/when the child
   * learns it. Call this as soon as it is known (`subagentPromptRuntime.ts`'s
   * `session_start` handler, today). The accepted value is returned for the
   * bootstrap status write, then retained here for the terminal status write.
   * See the module header's `sessionFile` section for why a too-long value is
   * dropped, not truncated.
   */
  recordSessionFile(sessionFile: string): string | undefined;
  /** The callback to wire into `TerminalPersistenceService.begin()`. See the module header for what it does and why, in this order. */
  mutateTerminalStatus(status: AsyncRunStatus, trigger: TerminalTrigger | undefined): void;
};

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : 'Unhandled rejection with no error message.';
}

interface TerminalOutcome {
  state: AsyncRunStatus['state'];
  success: boolean;
  error?: string;
}

export class RunnerReporting implements RunnerReportingContract {
  constructor(private readonly statusWriter: CoalescedStatusWriterContract<AsyncRunStatus>) {}

  protected now(): number {
    return Date.now();
  }

  protected writeResultFile(runId: string, result: RunResultFile): void {
    writeAtomicJson(resultPathFor(runId), result);
  }

  private prepared: RunnerResultInput | undefined;
  private recordedSessionFile: string | undefined;

  prepareResult(input: RunnerResultInput): void {
    this.prepared = input;
  }

  recordSessionFile(sessionFile: string): string | undefined {
    // Drop, don't truncate, past the bound - see the module header's
    // `sessionFile` section for why a shortened path is worse than no path.
    this.recordedSessionFile = sessionFile.length <= MAX_SESSION_FILE_CHARS ? sessionFile : undefined;
    return this.recordedSessionFile;
  }

  private resolveOutcome(trigger: TerminalTrigger | undefined): TerminalOutcome {
    if (trigger?.kind === 'signal') {
      return { state: 'stopped', success: false, error: `Terminated by signal ${trigger.signal}.` };
    }
    if (trigger?.kind === 'uncaughtException') {
      return { state: 'failed', success: false, error: trigger.error.message };
    }
    if (trigger?.kind === 'unhandledRejection') {
      return { state: 'failed', success: false, error: describeReason(trigger.reason) };
    }
    // trigger === undefined: the run's own explicit finalize() call.
    if (this.prepared) {
      return {
        state: this.prepared.state ?? (this.prepared.success ? 'completed' : 'failed'),
        success: this.prepared.success,
      };
    }
    return { state: 'failed', success: false, error: 'Run finalized without ever calling prepareResult().' };
  }

  mutateTerminalStatus(status: AsyncRunStatus, trigger: TerminalTrigger | undefined): void {
    const now = this.now();
    const outcome = this.resolveOutcome(trigger);

    const summary = this.prepared?.summary ?? outcome.error ?? '(no summary)';

    status.state = outcome.state;
    status.endedAt = now;
    status.lastUpdate = now;
    status.summary = truncateForStatus(summary);
    if (outcome.error) status.error = outcome.error;
    if (this.recordedSessionFile) status.sessionFile = this.recordedSessionFile;

    // Forces the mutation above onto disk before anything else in this
    // function runs. See the module header's WRITE ORDER section for why
    // this specific call, at this specific point, is what achieves that.
    this.statusWriter.updateSync(() => {});

    const result: RunResultFile = {
      runId: status.runId,
      agent: status.agent,
      success: outcome.success,
      state: outcome.state,
      summary,
      startedAt: status.startedAt,
      endedAt: now,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(this.prepared?.acceptance ? { acceptance: this.prepared.acceptance } : {}),
    };
    this.writeResultFile(status.runId, result);
  }
}
