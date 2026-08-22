/**
 * Provable-death check for one run's owning process.
 *
 * WHY THIS IS SMALLER THAN THE PREDECESSOR:
 * `doom-pi-subagents/src/runs/background/processTerminal.ts` proves process
 * termination by cross-referencing every spawned `pi` writer's own close
 * observation against an expected-writer-count candidate file, plus a
 * canonical-session-lease projection for resumability. None of that
 * infrastructure exists in this package yet (writer-close observation and
 * session-lease-aware resumability are later work). What this package already
 * has is `TerminalPersistenceService`'s crash marker: one file, written before
 * a run does anything else and cleared only once `finalize()` has actually
 * persisted a terminal result. That is already a complete answer to the one
 * question `StaleRunReconciler` needs answered - "did this run's process die
 * without ever finishing?" - so this module reads that marker instead of
 * reintroducing the predecessor's writer-candidate apparatus.
 *
 * WHY A SEPARATE MODULE FROM `TerminalPersistenceService`:
 * `TerminalPersistenceService` writes and clears the crash marker for the ONE
 * run its own process is guarding. Reading someone else's marker to judge
 * whether THEIR process died is a different responsibility, usually exercised
 * from a different process entirely (the one asking "is this stale?", not the
 * one that was running). Splitting it out is what lets `TerminalPersistenceService`'s
 * own header say "reading it to make that determination is a different
 * module's job" and mean it.
 *
 * THE VERDICT IS DELIBERATELY THREE-VALUED, NOT TWO:
 * `'crashed'` is the only value that authorizes a repair. `'alive'` and
 * `'unknown'` both mean "do not touch this run" - a live pid means it is
 * genuinely still running, and an unreadable pid liveness (`EPERM`, or no
 * marker at all for a run whose status claims to be in flight) means this
 * module cannot prove anything either way. Collapsing `'alive'` and
 * `'unknown'` into one "don't repair" value would hide, from every caller,
 * that ambiguity is a real observable outcome, not just the absence of one.
 *
 * AVOID:
 * - Ever returning `'crashed'` from anything other than an OS-confirmed ESRCH
 *   on the marker's pid. `EPERM`, a missing marker, or "no update in a long
 *   time" are all real conditions a caller may still want to know about, but
 *   none of them prove death, and treating them as though they did is exactly
 *   the guess `StaleRunReconciler` exists to refuse
 * - Writing anything here. This module only reads
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CRASH_MARKER_FILE_NAME } from './runs/background/terminalPersistence';
import { currentRunsDir } from './filesystem/paths';

const CRASH_MARKER_VERSION = 1;

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

/** A signal-0 probe, injectable so a test never sends a real signal to a real pid. */
export type PidProbe = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export interface CrashMarkerRecord {
  version: typeof CRASH_MARKER_VERSION;
  runId: string;
  pid: number;
  startedAt: number;
}

export type ProcessTerminalVerdict =
  | { state: 'alive'; marker: CrashMarkerRecord }
  | { state: 'crashed'; marker: CrashMarkerRecord }
  | { state: 'unknown'; marker: CrashMarkerRecord | undefined };

export type ProcessTerminalInspectorContract = {
  /** Whether `runId`'s owning process is provably dead, based on its crash marker. */
  inspect(runId: string): ProcessTerminalVerdict;
  /** Promise-based marker read for recurring reconciliation. */
  inspectAsync?(runId: string): Promise<ProcessTerminalVerdict>;
};

function crashMarkerPath(runId: string): string {
  return path.join(currentRunsDir(), runId, CRASH_MARKER_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * `kill(pid, 0)` sends no signal; it only asks the OS whether the pid could be
 * signalled. `ESRCH` is the OS actively confirming no such process exists -
 * the one condition this module trusts as proof. `EPERM` means a process is
 * there but this process may not signal it (commonly a different user), which
 * proves the opposite of death and is reported as `'unknown'` rather than
 * `'alive'` only because ownership, not existence, is what is uncertain there;
 * treating it as `'alive'` would also be a safe, defensible reading, but
 * `'unknown'` keeps the caller from building any certainty either way on it.
 */
export function checkPidLiveness(pid: number, probe: PidProbe = process.kill.bind(process)): ProcessLiveness {
  try {
    probe(pid, 0);
    return 'alive';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

export class ProcessTerminalInspector implements ProcessTerminalInspectorContract {
  /**
   * Process seam for tests: a unit test must never deliver a real signal to a
   * real pid.
   */
  protected probePid(pid: number): ProcessLiveness {
    return checkPidLiveness(pid);
  }

  protected readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  protected readCrashMarker(runId: string): CrashMarkerRecord | undefined {
    const raw = this.readFile(crashMarkerPath(runId));
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A marker mid-write (rename not yet visible, or a torn read) is not
      // evidence of anything; treated the same as no marker at all.
      return undefined;
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== CRASH_MARKER_VERSION ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'number'
    ) {
      return undefined;
    }
    return { version: CRASH_MARKER_VERSION, runId: parsed.runId, pid: parsed.pid, startedAt: parsed.startedAt };
  }

  protected async readFileAsync(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  protected async readCrashMarkerAsync(runId: string): Promise<CrashMarkerRecord | undefined> {
    const raw = await this.readFileAsync(crashMarkerPath(runId));
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== CRASH_MARKER_VERSION ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'number'
    ) {
      return undefined;
    }
    return { version: CRASH_MARKER_VERSION, runId: parsed.runId, pid: parsed.pid, startedAt: parsed.startedAt };
  }

  private verdictFor(marker: CrashMarkerRecord | undefined): ProcessTerminalVerdict {
    if (!marker) return { state: 'unknown', marker: undefined };
    const liveness = this.probePid(marker.pid);
    if (liveness === 'dead') return { state: 'crashed', marker };
    if (liveness === 'alive') return { state: 'alive', marker };
    return { state: 'unknown', marker };
  }

  inspect(runId: string): ProcessTerminalVerdict {
    return this.verdictFor(this.readCrashMarker(runId));
  }

  async inspectAsync(runId: string): Promise<ProcessTerminalVerdict> {
    return this.verdictFor(await this.readCrashMarkerAsync(runId));
  }
}
