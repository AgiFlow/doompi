/**
 * Dispatches the `subagent` tool's management/control `action` values to
 * services that already exist. Nothing new invented here - every method is
 * a thin composition, matching `spawnPlan.ts`'s own "preflight throws,
 * per-item failure does not" split where it applies.
 *
 * `list()` returns this process's tracked fleet. `status(id)` resolves the run
 * directory and uses the canonical status reader, preserving corrupt-status
 * failures instead of silently treating them as a missing run.
 *
 * WHAT "STEER SUCCEEDED" MEANS HERE:
 * `steer()` writes the request, then waits up to three seconds for the exact
 * request-id and child-index acknowledgment. The targeted consumer reads only
 * that file, so concurrent callers cannot consume each other's acknowledgments.
 * A timeout reports `pending`; a delivered or failed acknowledgment includes
 * the child's message unchanged for the tool surface to show the caller.
 */

import * as path from 'node:path';
import {
  consumeSteerAck,
  requestAsyncInterrupt,
  requestAsyncSteer,
  requestAsyncStop,
} from '../../intercom/supervisorControlChannel';
import type { AsyncRunStatus } from '../../runs/background/asyncExecution';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../asyncJobTracker';
import type { RunIdResolverContract } from '../../runIdResolver';
import { readAsyncRunStatusResultAt, readAsyncRunStatusResultAtAsync } from '../../statusReader';
import { STATUS_FILE_NAME } from '../../runs/background/statusWriter';
import { DoomTeamExpectedError } from '../../../services/support/errors';

export interface StatusActionResult {
  runId: string;
  runDir: string | undefined;
  resultPath?: string;
  claimed: boolean;
  status: AsyncRunStatus | undefined;
}

export interface ListActionResult {
  runs: TrackedAsyncJob[];
}

/** The interrupt/stop request file path written, for a caller that wants to report it. */
export interface ControlActionResult {
  requestPath: string;
}

/**
 * Deliberately separate from `ControlActionResult` because steering adds a
 * correlated acknowledgment state and message.
 */
export interface SteerActionResult {
  requestPath: string;
  requestId: string;
  index: number;
  state: 'delivered' | 'failed' | 'pending';
  message: string;
}

export interface ManagementActionsContract {
  /** Resolves `id` (exact or unambiguous prefix) and reads that run's own `status.json`. `status: undefined` when the run has none (yet, or ever). Throws only on an AMBIGUOUS prefix - see `RunIdResolver.resolve()`. */
  status(id: string): StatusActionResult;
  /** Promise-based status lookup for startup and polling paths. */
  statusAsync?(id: string): Promise<StatusActionResult>;
  /** Every run this process has tracked since it started tracking. Not every run that ever existed - see the module header. */
  list(): ListActionResult;
  interrupt(id: string, reason?: string): ControlActionResult;
  stop(id: string, reason?: string): ControlActionResult;
  /** Writes a steer request and waits briefly for that request's exact child acknowledgment. */
  steer(id: string, message: string, targetIndex?: number, signal?: AbortSignal): Promise<SteerActionResult>;
}

function resolveRunDirOrThrow(resolver: RunIdResolverContract, id: string): { runId: string; runDir: string } {
  const resolved = resolver.resolve(id);
  if (!resolved?.runDir) {
    throw new DoomTeamExpectedError(
      'run_not_found',
      `No active run matches '${id}'.`,
      false,
      'Call subagent({"action":"status"}) and retry with an exact run id.',
    );
  }
  return { runId: resolved.runId, runDir: resolved.runDir };
}

export class ManagementActions implements ManagementActionsContract {
  protected readonly steerAckTimeoutMs: number = 3_000;
  protected readonly steerAckPollIntervalMs: number = 25;

  constructor(
    private readonly runIds: RunIdResolverContract,
    private readonly jobs: AsyncJobTrackerContract,
  ) {}

  /** Generated up front so the caller (and, later, an ack-wait) can correlate a steer request without parsing it back out of the written file's path. */
  protected generateSteerRequestId(): string {
    return crypto.randomUUID();
  }

  protected readRunStatus(runDir: string): AsyncRunStatus | undefined {
    const result = readAsyncRunStatusResultAt(path.join(runDir, STATUS_FILE_NAME));
    if (result.kind === 'ok') return result.status;
    if (result.kind === 'missing') return undefined;
    throw new DoomTeamExpectedError(
      'status_corrupt',
      `Run status is ${result.kind} at '${result.path}'.`,
      result.kind === 'io_error',
      'Inspect the run transcript or stop the run, then retry status.',
    );
  }

  protected async readRunStatusAsync(runDir: string): Promise<AsyncRunStatus | undefined> {
    const result = await readAsyncRunStatusResultAtAsync(path.join(runDir, STATUS_FILE_NAME));
    if (result.kind === 'ok') return result.status;
    if (result.kind === 'missing') return undefined;
    throw new DoomTeamExpectedError(
      'status_corrupt',
      `Run status is ${result.kind} at '${result.path}'.`,
      result.kind === 'io_error',
      'Inspect the run transcript or stop the run, then retry status.',
    );
  }

  status(id: string): StatusActionResult {
    const resolved = this.runIds.resolve(id);
    if (!resolved) {
      return { runId: id, runDir: undefined, resultPath: undefined, claimed: false, status: undefined };
    }
    return {
      runId: resolved.runId,
      runDir: resolved.runDir,
      resultPath: resolved.resultPath,
      claimed: resolved.claimed,
      status: resolved.runDir ? this.readRunStatus(resolved.runDir) : undefined,
    };
  }

  async statusAsync(id: string): Promise<StatusActionResult> {
    const resolved = this.runIds.resolveAsync ? await this.runIds.resolveAsync(id) : this.runIds.resolve(id);
    if (!resolved) {
      return { runId: id, runDir: undefined, resultPath: undefined, claimed: false, status: undefined };
    }
    return {
      runId: resolved.runId,
      runDir: resolved.runDir,
      resultPath: resolved.resultPath,
      claimed: resolved.claimed,
      status: resolved.runDir ? await this.readRunStatusAsync(resolved.runDir) : undefined,
    };
  }

  list(): ListActionResult {
    return { runs: this.jobs.list() };
  }

  interrupt(id: string, reason?: string): ControlActionResult {
    const { runDir } = resolveRunDirOrThrow(this.runIds, id);
    return { requestPath: requestAsyncInterrupt(runDir, reason ? { reason } : {}) };
  }

  stop(id: string, reason?: string): ControlActionResult {
    const { runDir } = resolveRunDirOrThrow(this.runIds, id);
    return { requestPath: requestAsyncStop(runDir, reason ? { reason } : {}) };
  }

  protected wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Steer acknowledgment wait cancelled.'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Steer acknowledgment wait cancelled.'));
        },
        { once: true },
      );
    });
  }

  async steer(id: string, message: string, targetIndex?: number, signal?: AbortSignal): Promise<SteerActionResult> {
    const { runDir } = resolveRunDirOrThrow(this.runIds, id);
    const resolvedIndex = targetIndex ?? this.readRunStatus(runDir)?.fanoutIndex ?? 0;
    const requestId = this.generateSteerRequestId();
    const requestPath = requestAsyncSteer(runDir, {
      message,
      id: requestId,
      targetIndex: resolvedIndex,
    });
    const deadline = Date.now() + this.steerAckTimeoutMs;
    while (Date.now() <= deadline) {
      const ack = consumeSteerAck(runDir, resolvedIndex, requestId);
      if (ack) {
        return { requestPath, requestId, index: ack.index, state: ack.state, message: ack.message };
      }
      await this.wait(this.steerAckPollIntervalMs, signal);
    }
    return {
      requestPath,
      requestId,
      index: resolvedIndex,
      state: 'pending',
      message: 'No child acknowledgment arrived within 3 seconds.',
    };
  }
}
