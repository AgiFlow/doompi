/**
 * The child-side half of the spawn handshake: reads the launch config the
 * parent (`AsyncSubagentSpawner`) wrote, opens this run's status, wires
 * `RunnerReporting`'s finalize callback into `TerminalPersistenceService`,
 * and signals the parent that this process is ready to proceed.
 *
 * "Nothing works until this exists" (per the task brief): `SpawnHandshake`
 * on the parent side blocks on exactly the file this class writes at the
 * end of `bootstrap()`.
 *
 * WHY THE RUN ID COMES FROM THE ENVIRONMENT, NOT AN ARGUMENT:
 * `SUBAGENT_RUN_ID_ENV` is already the wire contract `buildPiArgs` encodes a
 * run's id into (see `env.ts`); this process discovers its own identity the
 * same way every other piece of this package's child-side machinery would
 * (`SUBAGENT_CHILD_INDEX_ENV`, etc.), rather than requiring whatever calls
 * `bootstrap()` to already know it and pass it in redundantly. An explicit
 * override is still accepted for tests and for a caller that has a genuine
 * reason to know better.
 *
 * WHY A BOOTSTRAP FAILURE REPORTS THROUGH THE HANDSHAKE'S `error` FIELD
 * ONLY:
 * The predecessor invented a second file (`runner-startup.json`, `state:
 * 'error'`) for exactly this case, which is part of why a reader had to
 * check three separate files to know whether a run was actually finished
 * (see `asyncExecution.ts`'s finalization diagnosis). `SpawnHandshake`
 * already has a vocabulary for this - `{state:'error', error}` at the SAME
 * path it watches for `{state:'ready'}` - so a bootstrap failure uses that,
 * not a parallel channel.
 *
 * WHAT REMAINS UNPROVEN UNTIL `subagentPromptRuntime.ts` LANDS:
 * This class is complete and independently testable, but nothing in this
 * package yet calls it for a real spawned child - that entry point is a
 * separate, concurrent port (see `asyncExecution.ts`'s header). Until then,
 * `bootstrap()`'s only proof of correctness is its own unit tests against
 * the documented contract, not an end-to-end run.
 *
 * TEAM MEMBERSHIP IS ADDITIVE, NEVER FATAL:
 * `bootstrap()` also joins this run's `runId` to the native team as a new
 * member (`RunnerTeamMembership`), when the parent forwarded a team root
 * (see `asyncExecution.ts`'s TEAM MEMBERSHIP ENV FORWARDING section) - a
 * child that cannot be messaged, asked, or seen on the shared task board by
 * its siblings is a real gap, but it is not a reason to fail the run itself.
 * A registration failure is recorded (`onTeamRegistrationFailed`), not
 * thrown, and everything else proceeds exactly as if no team root had been
 * present at all.
 *
 * DISPOSAL RIDES THE ONE FINALIZE PATH, NOT A SECOND ONE:
 * The registration's `dispose()` is called from inside the SAME callback
 * passed to `terminalPersistence.begin()` that `RunnerReporting` already
 * owns, immediately after `mutateTerminalStatus` - not from a second,
 * independent cleanup site. `TerminalPersistenceService`'s own `finalized`
 * boolean is still the only thing deciding whether that callback runs at
 * all, so a child that finalizes for any reason (completion, signal,
 * uncaught exception) also leaves the team exactly once, for the same
 * reason there is exactly one finalize.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SUBAGENT_RUN_ID_ENV } from '../../../types/environment';
import { writeAtomicJson } from '../../atomicJson';
import { currentRunConfigPath, currentRunsDir } from '../../filesystem/paths';
import type { TeamMemberContext } from '../../intercom/nativeTeamChannel';
import { type AsyncRunStatus, handshakePathFor, type LaunchConfig } from './asyncExecution';
import type { RunnerReportingContract } from './runnerReporting';
import type { RunnerTeamMembershipContract, RunnerTeamRegistration } from './runnerTeamMembership';
import { type CoalescedStatusWriterContract } from './statusWriter';
import type { TerminalPersistenceContract } from './terminalPersistence';

const STATUS_FILE_NAME = 'status.json';

export type RunnerLaunchConfig = LaunchConfig;

export interface RunnerBootstrapResult {
  runId: string;
  launchConfig: RunnerLaunchConfig;
  /** This run's own bound team membership, when it joined one. Same instance `registerTeamMembership` already holds. */
  teamContext: TeamMemberContext | undefined;
}

export type RunnerBootstrapContract = {
  /**
   * Read the launch config, open status, wire finalize, and signal ready.
   * Throws (after writing an error handshake) on any failure to reach that
   * point - a bootstrap that cannot even establish this run's identity has
   * nothing else it can safely do.
   */
  bootstrap(runId?: string, sessionFile?: string): RunnerBootstrapResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export class RunnerBootstrap implements RunnerBootstrapContract {
  constructor(
    private readonly statusWriter: CoalescedStatusWriterContract<AsyncRunStatus>,
    private readonly terminalPersistence: TerminalPersistenceContract<AsyncRunStatus>,
    private readonly reporting: RunnerReportingContract,
    private readonly teamMembership: RunnerTeamMembershipContract,
  ) {}

  protected now(): number {
    return Date.now();
  }

  protected resolveRunIdFromEnv(): string | undefined {
    const value = process.env[SUBAGENT_RUN_ID_ENV];
    return value?.trim() ? value : undefined;
  }

  protected readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  protected writeHandshake(filePath: string, payload: { state: 'ready' } | { state: 'error'; error: string }): void {
    writeAtomicJson(filePath, payload);
  }

  /** Recorded, not thrown - see the module header's TEAM MEMBERSHIP IS ADDITIVE section. */
  lastTeamRegistrationError: { runId: string; error: unknown; at: number } | undefined;

  protected onTeamRegistrationFailed(runId: string, error: unknown): void {
    this.lastTeamRegistrationError = { runId, error, at: this.now() };
  }

  /**
   * Join the native team as a new member for this run, if the parent
   * forwarded a team root. `undefined` when this run is not part of a team
   * - a silent no-op, not a failure (see `asyncExecution.ts`'s TEAM
   * MEMBERSHIP ENV FORWARDING section).
   */
  protected registerTeamMembership(
    launchConfig: RunnerLaunchConfig,
    fanoutIndex: number | undefined,
  ): RunnerTeamRegistration | undefined {
    const root = this.teamMembership.readRoot();
    if (!root) return undefined;
    return this.teamMembership.register({
      root,
      role: 'subagent',
      agent: launchConfig.agent,
      runId: launchConfig.runId,
      childIndex: launchConfig.childIndex,
      // Only a fan-out child gets a `-N` suffix on its member name; a
      // standalone run has no sibling to disambiguate against.
      fanoutIndex,
      task: { id: launchConfig.runId, subject: launchConfig.task },
      pid: process.pid,
    });
  }

  protected readExistingStatus(runId: string): AsyncRunStatus | undefined {
    // Best-effort: the parent already wrote an initial status.json for this
    // run (`AsyncSubagentSpawner.spawn()`); reading it back preserves
    // parent-decided fields (`fanoutIndex`) rather than this process
    // reconstructing them from nothing.
    const raw = this.readFile(path.join(currentRunsDir(), runId, STATUS_FILE_NAME));
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? (parsed as unknown as AsyncRunStatus) : undefined;
    } catch {
      return undefined;
    }
  }

  private readLaunchConfig(runId: string): RunnerLaunchConfig {
    const configPath = currentRunConfigPath(runId);
    const raw = this.readFile(configPath);
    if (raw === undefined) {
      throw new Error(`No launch config found for run '${runId}' at '${configPath}'.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Launch config for run '${runId}' is not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(parsed) || typeof parsed.runId !== 'string' || parsed.runId !== runId) {
      throw new Error(`Launch config for run '${runId}' is missing or has a mismatched 'runId'.`);
    }
    return parsed as unknown as RunnerLaunchConfig;
  }

  bootstrap(runId?: string, sessionFile?: string): RunnerBootstrapResult {
    const resolvedRunId = runId ?? this.resolveRunIdFromEnv();
    if (!resolvedRunId) {
      // Nothing identifies this run yet, so there is no handshake path to
      // write an error to either; this can only surface as a thrown error.
      throw new Error(`No run id available: '${SUBAGENT_RUN_ID_ENV}' is not set and none was supplied.`);
    }

    let launchConfig: RunnerLaunchConfig;
    try {
      launchConfig = this.readLaunchConfig(resolvedRunId);
    } catch (error) {
      this.writeHandshake(handshakePathFor(resolvedRunId), {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    try {
      const now = this.now();
      const existing = this.readExistingStatus(resolvedRunId);
      const fanoutIndex = existing?.fanoutIndex;
      this.statusWriter.open(resolvedRunId, {
        ...existing,
        version: 1,
        runId: resolvedRunId,
        agent: launchConfig.agent,
        state: 'running',
        startedAt: existing?.startedAt ?? now,
        lastUpdate: now,
        ...(sessionFile ? { sessionFile } : {}),
        ...(fanoutIndex === undefined ? {} : { fanoutIndex }),
      });

      let teamRegistration: RunnerTeamRegistration | undefined;
      try {
        teamRegistration = this.registerTeamMembership(launchConfig, fanoutIndex);
      } catch (error) {
        // Additive, never fatal - see the module header's TEAM MEMBERSHIP
        // IS ADDITIVE section.
        this.onTeamRegistrationFailed(resolvedRunId, error);
      }

      this.terminalPersistence.begin(resolvedRunId, (status, trigger) => {
        this.reporting.mutateTerminalStatus(status, trigger);
        // Disposal rides this SAME callback, not a second cleanup site - see
        // the module header's DISPOSAL RIDES THE ONE FINALIZE PATH section.
        teamRegistration?.dispose();
      });

      this.writeHandshake(launchConfig.handshakePath, { state: 'ready' });

      return {
        runId: resolvedRunId,
        launchConfig,
        teamContext: teamRegistration?.context,
      };
    } catch (error) {
      this.writeHandshake(launchConfig.handshakePath, {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
