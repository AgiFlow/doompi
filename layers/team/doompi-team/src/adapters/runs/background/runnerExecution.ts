/**
 * The "while running" glue: consumes steer/interrupt/timeout/stop requests
 * via `ControlChannelWatcher`, and is the ONE place every terminal trigger
 * (interrupt/stop/timeout, and normal completion) funnels through
 * `TerminalPersistenceService.finalize()`.
 *
 * WHY EVERY TRIGGER CALLS THE SAME `finalize()`, INSTEAD OF EACH DOING ITS
 * OWN THING:
 * The predecessor's `interruptRunner`/`stopRunner`/`timeoutRunner` and its
 * post-loop completion tail each independently computed terminal state and
 * independently wrote it - four triggers, four write sites, each guarded
 * only by a LOCAL boolean that stopped re-entry of THAT SAME handler, none
 * of them aware of the others (see `asyncExecution.ts`'s header for the
 * full diagnosis, including why that made a stray control event able to
 * race the completion tail). Here, `interrupt()`/`stop()`/`timeout()`/
 * `complete()` each do exactly two things: record the outcome via
 * `reporting.prepareResult()`, then call `terminalPersistence.finalize()`.
 * `TerminalPersistenceService`'s own `finalized` boolean, checked and set
 * before anything else runs, is the ONLY thing that decides whether a given
 * call actually does anything. No new idempotency logic is added here -
 * every trigger is made to go through the one that already exists, rather
 * than rolling its own.
 *
 * WHY INTERRUPT/STOP/TIMEOUT EACH STILL CALL `prepareResult()`:
 * `RunnerReporting.mutateTerminalStatus`'s fallback derives a correct
 * outcome from `trigger` for real OS signals/exceptions - but interrupt/
 * stop/timeout are NOT `TerminalTrigger` values (those are this run's own
 * request-driven terminal reasons, not the signals/exceptions
 * `TerminalPersistenceService` itself watches for), and `finalize()` always
 * calls `mutateTerminalStatus` with `trigger === undefined` regardless of
 * WHY this class decided to call it. So each of `interrupt()`/`stop()`/
 * `timeout()` prepares its own result before calling `finalize()`, the same
 * as `complete()` does - `mutateTerminalStatus` cannot otherwise tell
 * interrupt apart from stop apart from normal completion.
 *
 */

import type { ActivityState } from '../../../types';
import type {
  ControlChannelWatchHandlers,
  ControlChannelWatcherContract,
  SteerRequest,
} from '../../intercom/supervisorControlChannel';
import type { AsyncRunStatus } from './asyncExecution';
import { runDirFor } from './asyncExecution';
import type { RunnerReportingContract } from './runnerReporting';
import type { CoalescedStatusWriterContract } from './statusWriter';
import type { TerminalPersistenceContract } from './terminalPersistence';

export interface RunnerExecutionHandlers {
  /** Forwarded steer requests, for whatever delivers them to the running step (not this class's job). */
  onSteer?: (request: SteerRequest) => void;
}

export interface RunnerProgress {
  tokens?: number;
  currentTool?: string;
  toolCount?: number;
}

export type RunnerExecutionContract = {
  /**
   * Start watching this run's control inbox and consuming any chain-append
   * requests already waiting. Returns a disposer that stops watching
   * without finalizing (used on a clean, already-finalized exit).
   */
  start(runId: string, handlers?: RunnerExecutionHandlers): () => void;
  /** Record a material, event-driven activity transition. */
  setActivity(activity: ActivityState): void;
  /** Record live child metrics in one coalesced status update. */
  setProgress(progress: RunnerProgress): void;
  /** This run finished normally. Idempotent via `TerminalPersistenceService`. */
  complete(success: boolean, summary: string): void;
};

export class RunnerExecution implements RunnerExecutionContract {
  constructor(
    private readonly controlChannel: ControlChannelWatcherContract,
    private readonly terminalPersistence: TerminalPersistenceContract<AsyncRunStatus>,
    private readonly reporting: RunnerReportingContract,
    private readonly statusWriter: CoalescedStatusWriterContract<AsyncRunStatus>,
  ) {}

  /** Dedicated runner processes own exactly one session, so a stop may exit after synchronous persistence. */
  protected exitProcess(code: number): void {
    process.exit(code);
  }

  start(runId: string, handlers: RunnerExecutionHandlers = {}): () => void {
    const controlHandlers: ControlChannelWatchHandlers = {
      onInterrupt: () => this.interrupt(),
      onStop: () => this.stop(),
      onTimeout: () => this.timeout(),
      ...(handlers.onSteer ? { onSteer: handlers.onSteer } : {}),
    };
    return this.controlChannel.watch(runDirFor(runId), controlHandlers);
  }

  setActivity(activity: ActivityState): void {
    this.statusWriter.update((status) => {
      status.activityState = activity;
      status.lastUpdate = Date.now();
    });
  }

  setProgress(progress: RunnerProgress): void {
    if (progress.tokens === undefined && progress.currentTool === undefined && progress.toolCount === undefined) {
      return;
    }
    this.statusWriter.update((status) => {
      if (progress.tokens !== undefined) status.tokens = progress.tokens;
      if (progress.currentTool !== undefined) status.currentTool = progress.currentTool;
      if (progress.toolCount !== undefined) status.toolCount = progress.toolCount;
      status.lastUpdate = Date.now();
    });
  }

  complete(success: boolean, summary: string): void {
    this.reporting.prepareResult({ success, summary });
    this.terminalPersistence.finalize();
  }

  interrupt(): void {
    this.reporting.prepareResult({ success: false, summary: 'Interrupted before completion.' });
    this.terminalPersistence.finalize();
  }

  stop(): void {
    this.reporting.prepareResult({ success: false, state: 'stopped', summary: 'Stopped before completion.' });
    try {
      this.terminalPersistence.finalize();
    } finally {
      this.exitProcess(0);
    }
  }

  timeout(): void {
    this.reporting.prepareResult({ success: false, summary: 'Timed out before completion.' });
    this.terminalPersistence.finalize();
  }
}
