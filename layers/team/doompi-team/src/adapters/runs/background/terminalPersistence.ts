/**
 * Guarantees one runner process ends with a persisted terminal result.
 *
 * WHY THIS EXISTS:
 * The predecessor's runner finalization
 * (`doom-pi-subagents/src/runs/background/subagent-runner.ts`) is straight-line
 * code with no `try`/`finally` and no signal handling beyond `SIGUSR2`. A throw
 * anywhere in that path, or a `SIGTERM`/`SIGKILL` of the runner process, leaves
 * the run's `status.json` reporting `running` for up to 24 hours, with the
 * `pi` child it spawned still alive and still burning tokens. A user who hits
 * Ctrl-C on a foreground run gets exactly this: the terminal returns, but the
 * child and the stale "running" status both live on.
 *
 * DESIGN PATTERNS:
 * - One runner process runs exactly one run, so this is a singleton holding the
 *   state of the one run it is guarding, the same shape as `CoalescedStatusWriter`
 * - `CoalescedStatusWriterContract` is injected, not assumed: this class holds a real
 *   reference to the one true `status.json` writer and calls its synchronous
 *   `updateSync` itself, rather than trusting a caller-supplied closure to have
 *   done so. `mutateTerminalStatus` stays a caller-supplied closure for the
 *   run's own richer status SHAPE only - this class does not know what fields
 *   a terminal status carries, just that writing them goes through the one
 *   writer, by construction rather than by docstring
 * - Idempotency is a single boolean guard checked and set before anything else
 *   happens, so a second trigger - a duplicate signal, a throw during the first
 *   finalize - observes "already finalized" before it can do anything
 * - Signal and process-exit machinery are `protected` seams so a unit test
 *   never delivers a real signal to, or calls the real `process.exit` on, the
 *   process running the test
 *
 * THE CRASH MARKER:
 * `begin()` writes a small marker file before the run does anything else, and
 * a successful `finalize()` deletes it. A run that dies so hard it never reaches
 * `finalize()` at all (`SIGKILL`, a host crash) leaves the marker behind with no
 * result file next to it - the marker's `pid` is then dead, which is what lets a
 * later reader tell "crashed" apart from "still running": a genuinely running
 * run also has a live marker, but with a live pid. This module only writes and
 * clears the marker; reading it to make that determination is a different
 * module's job.
 *
 * AVOID:
 * - Calling `mutateTerminalStatus` with anything that can be asynchronous. The
 *   whole guarantee here depends on finalize running to completion before
 *   another trigger can observe the `finalized` flag, which only holds if
 *   every step, including `CoalescedStatusWriter.updateSync`, is synchronous
 * - Writing `status.json` from here directly with `writeAtomicJson`; the
 *   injected `CoalescedStatusWriterContract` is the only thing that may touch it
 * - Calling `process.removeAllListeners` for a signal; that would remove a
 *   listener some other module in the same process installed, not just ours
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeAtomicJson } from '../../atomicJson';
import { currentRunsDir } from '../../filesystem/paths';
import type { CoalescedStatusWriterContract, StatusWithRecentEntries } from './statusWriter';

/**
 * The one crash-marker filename.
 *
 * Exported because `processTerminal.ts` reads this marker to decide whether a
 * run died without finishing. It writes the marker, that module reads it, and
 * they must not drift.
 */
export const CRASH_MARKER_FILE_NAME = 'runner-crash-marker.json';
const CRASH_MARKER_VERSION = 1;

/** Exit code used for a fatal exception, matching Node's own default for an uncaught error. */
const FATAL_EXCEPTION_EXIT_CODE = 1;

/** What triggered a terminal finalize, so the caller's `mutateTerminalStatus` closure can record why. */
export type TerminalTrigger =
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'uncaughtException'; error: Error }
  | { kind: 'unhandledRejection'; reason: unknown };

interface CrashMarkerRecord {
  version: typeof CRASH_MARKER_VERSION;
  runId: string;
  pid: number;
  startedAt: number;
}

function crashMarkerPath(runId: string): string {
  return path.join(currentRunsDir(), runId, CRASH_MARKER_FILE_NAME);
}

/** `128 + signal number`, the shell convention for a process killed by a signal. */
function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + os.constants.signals[signal];
}

export interface TerminalPersistenceContract<TStatus extends StatusWithRecentEntries = StatusWithRecentEntries> {
  /**
   * Start guarding one run: writes the crash marker and installs the signal
   * and exception handlers. Safe to call again, on the same or a different
   * run id - a second call tears down whatever this instance was previously
   * guarding first, the same reset semantics as `CoalescedStatusWriter.open`.
   *
   * `mutateTerminalStatus` is called at most once, synchronously, on the
   * already-open status passed to `CoalescedStatusWriter.updateSync`, whenever
   * the run reaches a terminal state: `trigger` is undefined for the run's own
   * call to `finalize()`, and describes the signal or exception for every
   * other path. The caller is responsible for having called
   * `CoalescedStatusWriterContract.open()` before the run's terminal state can be
   * reached; this class only mutates and flushes, it does not open.
   */
  begin(runId: string, mutateTerminalStatus: (status: TStatus, trigger: TerminalTrigger | undefined) => void): void;
  /** Track a spawned `pi` child so it is killed when this run finalizes. */
  trackChild(pid: number): void;
  /** Stop tracking a child that already exited on its own. */
  untrackChild(pid: number): void;
  /**
   * The run's own terminal call: persists the result through the injected
   * status writer's synchronous flush path, kills every tracked child, and
   * clears the crash marker. Idempotent - a second call, from any source,
   * including a signal that arrives after this one returns, is a no-op.
   */
  finalize(): void;
  /** Remove the installed signal and exception handlers without finalizing. */
  dispose(): void;
}

/**
 * Owner of the one run a runner process guards.
 *
 * WHY THIS IS A SERVICE AND NOT A TOP-LEVEL FUNCTION:
 * The predecessor's finalization lived inline in the runner's main function, so
 * nothing else in that module could trigger it, and a signal handler installed
 * elsewhere had no way to reach it. Putting it on an injectable instance gives
 * every part of the runner - the main run loop, a spawn-site failure, a signal
 * handler - the same `finalize()` to call, all guarded by the same flag.
 */
export class TerminalPersistenceService<
  TStatus extends StatusWithRecentEntries = StatusWithRecentEntries,
> implements TerminalPersistenceContract<TStatus> {
  constructor(private readonly statusWriter: CoalescedStatusWriterContract<TStatus>) {}

  private runId: string | undefined;
  private mutateTerminalStatus: ((status: TStatus, trigger: TerminalTrigger | undefined) => void) | undefined;
  /**
   * Starts `true` so that a call to `finalize()` or a delivered signal before
   * `begin()` has ever run is a safe no-op rather than a crash on undefined
   * state.
   */
  private finalized = true;
  private handlersInstalled = false;
  private readonly trackedChildPids = new Set<number>();

  // Bound once per instance so `offSignal`/`offUncaughtException` remove the
  // exact function reference `onSignal`/`onUncaughtException` installed.
  private readonly handleSigterm = (): void => this.handleSignal('SIGTERM');
  private readonly handleSigint = (): void => this.handleSignal('SIGINT');
  private readonly handleSighup = (): void => this.handleSignal('SIGHUP');
  private readonly handleUncaughtException = (error: Error): void =>
    this.handleFatal({ kind: 'uncaughtException', error });
  private readonly handleUnhandledRejection = (reason: unknown): void =>
    this.handleFatal({ kind: 'unhandledRejection', reason });

  protected now(): number {
    return Date.now();
  }

  // ---------------------------------------------------------------------
  // Process seams. A test subclass overrides every one of these so a unit
  // test never registers a real signal handler, never signals a real pid,
  // and never calls the real `process.exit` on the process running the test.
  // ---------------------------------------------------------------------

  protected onSignal(event: NodeJS.Signals, handler: NodeJS.SignalsListener): void {
    process.on(event, handler);
  }

  protected offSignal(event: NodeJS.Signals, handler: NodeJS.SignalsListener): void {
    process.off(event, handler);
  }

  protected onUncaughtException(handler: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void): void {
    process.on('uncaughtException', handler);
  }

  protected offUncaughtException(handler: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void): void {
    process.off('uncaughtException', handler);
  }

  protected onUnhandledRejection(handler: (reason: unknown, promise: Promise<unknown>) => void): void {
    process.on('unhandledRejection', handler);
  }

  protected offUnhandledRejection(handler: (reason: unknown, promise: Promise<unknown>) => void): void {
    process.off('unhandledRejection', handler);
  }

  protected killProcess(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited, or never existed. Nothing left to kill, which is the
      // outcome we wanted anyway.
    }
  }

  protected exitProcess(code: number): void {
    // Excluded from coverage: calling the real implementation would terminate
    // the process running whichever suite exercises this class, so every
    // test overrides this seam instead of triggering it for real.
    /* v8 ignore next */
    process.exit(code);
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  begin(runId: string, mutateTerminalStatus: (status: TStatus, trigger: TerminalTrigger | undefined) => void): void {
    // A second begin() is a reset: tear down whatever this instance was
    // previously guarding before starting the new one.
    this.dispose();
    this.runId = runId;
    this.mutateTerminalStatus = mutateTerminalStatus;
    this.finalized = false;
    this.trackedChildPids.clear();
    this.writeCrashMarker(runId);
    this.installHandlers();
  }

  trackChild(pid: number): void {
    this.trackedChildPids.add(pid);
  }

  untrackChild(pid: number): void {
    this.trackedChildPids.delete(pid);
  }

  finalize(): void {
    this.triggerFinalize(undefined);
  }

  dispose(): void {
    if (!this.handlersInstalled) return;
    this.handlersInstalled = false;
    this.offSignal('SIGTERM', this.handleSigterm);
    this.offSignal('SIGINT', this.handleSigint);
    this.offSignal('SIGHUP', this.handleSighup);
    this.offUncaughtException(this.handleUncaughtException);
    this.offUnhandledRejection(this.handleUnhandledRejection);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private installHandlers(): void {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;
    this.onSignal('SIGTERM', this.handleSigterm);
    this.onSignal('SIGINT', this.handleSigint);
    this.onSignal('SIGHUP', this.handleSighup);
    this.onUncaughtException(this.handleUncaughtException);
    this.onUnhandledRejection(this.handleUnhandledRejection);
  }

  private handleSignal(signal: NodeJS.Signals): void {
    this.triggerFinalize({ kind: 'signal', signal });
    // Registering a listener for these signals suppresses Node's default
    // terminate-on-signal behaviour, so once we have finalized we must end
    // the process ourselves - otherwise the signal is effectively swallowed
    // and the process hangs instead of honouring the Ctrl-C or `kill` that
    // was sent to it.
    this.exitProcess(signalExitCode(signal));
  }

  private handleFatal(trigger: TerminalTrigger): void {
    this.triggerFinalize(trigger);
    this.exitProcess(FATAL_EXCEPTION_EXIT_CODE);
  }

  /**
   * The idempotency gate every trigger funnels through.
   *
   * FIX: checked and set before anything else runs, so a second trigger -
   * whether that is `finalize()` called twice, a signal that arrives while
   * the first finalize is still on the stack, or a signal delivered after a
   * normal finalize already ran - observes `finalized === true` and returns
   * immediately. Because every step from here down is synchronous, there is
   * no `await` between the check and the set for a second trigger to race.
   */
  private triggerFinalize(trigger: TerminalTrigger | undefined): void {
    if (this.finalized) return;
    this.finalized = true;
    // Removed before persisting, not after: if a fatal signal arrives while
    // `mutateTerminalStatus` itself is running, it must not re-enter this
    // method through a reinstalled handler while the first pass is already
    // committed to exiting.
    this.dispose();
    try {
      const mutate = this.mutateTerminalStatus;
      // Excluded from coverage: unreachable by construction, for the same
      // reason as the runId guard below - mutateTerminalStatus is always set
      // once begin() has run, which finalized guards.
      /* v8 ignore next */
      if (mutate) this.statusWriter.updateSync((status) => mutate(status, trigger));
      // Only cleared once a result has actually been persisted. If the
      // mutator throws, the marker is left in place - that is the accurate
      // state: the run started and never produced a result, which is exactly
      // what the marker exists to record.
      this.clearCrashMarker();
    } finally {
      // Killing tracked children is unconditional: an orphaned child must not
      // survive a failed persist any more than it survives a successful one.
      this.killTrackedChildren();
    }
  }

  private killTrackedChildren(): void {
    for (const pid of this.trackedChildPids) this.killProcess(pid, 'SIGKILL');
    this.trackedChildPids.clear();
  }

  private writeCrashMarker(runId: string): void {
    const marker: CrashMarkerRecord = {
      version: CRASH_MARKER_VERSION,
      runId,
      pid: process.pid,
      startedAt: this.now(),
    };
    writeAtomicJson(crashMarkerPath(runId), marker);
  }

  private clearCrashMarker(): void {
    // Excluded from coverage: unreachable by construction. triggerFinalize
    // only reaches here once `finalized` has been observed false, which only
    // happens after begin() has already set runId - kept as a defensive
    // check instead of a non-null assertion, not as a reachable branch.
    /* v8 ignore next */
    if (!this.runId) return;
    try {
      fs.rmSync(crashMarkerPath(this.runId), { force: true });
    } catch {
      // Best effort: a marker that resists removal still correctly reads as
      // "this run may have crashed" to a later reader, which is the safe
      // direction for this cleanup to fail in.
    }
  }
}
