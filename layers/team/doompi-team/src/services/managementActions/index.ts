/**
 * Session-scoped management over in-memory run projections and typed controls.
 * Live status and control never read or write filesystem mailboxes.
 */

import { randomUUID } from 'node:crypto';

import type { AsyncJobTrackerContract, TrackedAsyncJob, TrackedAsyncJobsContract } from '../asyncJobTracker';
import type { SessionScope } from '../sessionPaths';
import type { NativeRunCoordinatorContract } from '../nativeRunCoordinator';
import type { ExternalProcessIpc } from '../externalProcessIpc';
import type { AsyncRunStatus } from '../asyncExecution';
import { DoomTeamExpectedError } from '../errors';

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

export interface ControlActionResult {
  requestId: string;
}

export interface SteerActionResult {
  requestId: string;
  index: number;
  state: 'delivered' | 'failed' | 'pending';
  message: string;
}

export interface ManagementActionsContract {
  bindSessionScope(scope: SessionScope): void;
  releaseSessionScope?(scope: SessionScope): void;
  status(id: string): StatusActionResult;
  statusAsync?(id: string): Promise<StatusActionResult>;
  list(): ListActionResult;
  interrupt(id: string, reason?: string): Promise<ControlActionResult>;
  stop(id: string, reason?: string): Promise<ControlActionResult>;
  steer(id: string, message: string, targetIndex?: number, signal?: AbortSignal): Promise<SteerActionResult>;
}

function statusProjection(job: TrackedAsyncJob): AsyncRunStatus {
  const now = job.updatedAt ?? job.startedAt ?? Date.now();
  return {
    version: 1,
    runId: job.runId,
    agent: job.agent ?? 'unknown',
    ...(job.task === undefined ? {} : { task: job.task }),
    cwd: job.cwd ?? '',
    ...(job.runtime === undefined ? {} : { runtime: job.runtime }),
    state: job.status as AsyncRunStatus['state'],
    startedAt: job.startedAt ?? now,
    lastUpdate: now,
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.activityState === undefined ? {} : { activityState: job.activityState }),
    ...(job.attentionReason === undefined ? {} : { attentionReason: job.attentionReason }),
    ...(job.sessionFile === undefined ? {} : { sessionFile: job.sessionFile }),
    ...(job.summary === undefined ? {} : { summary: job.summary }),
    ...(job.tokens === undefined ? {} : { tokens: job.tokens }),
    ...(job.cost === undefined ? {} : { cost: job.cost }),
    ...(job.currentTool === undefined ? {} : { currentTool: job.currentTool }),
    ...(job.toolCount === undefined ? {} : { toolCount: job.toolCount }),
  };
}

export class ManagementActions implements ManagementActionsContract {
  private scope: SessionScope | undefined;

  constructor(
    private readonly jobs: AsyncJobTrackerContract,
    private readonly nativeRuns?: NativeRunCoordinatorContract,
    private readonly externalProcesses?: ExternalProcessIpc,
  ) {}

  bindSessionScope(scope: SessionScope): void {
    if (this.scope && this.scope.scopeKey !== scope.scopeKey) {
      throw new Error('Team management scope is immutable for the active session runtime.');
    }
    this.scope = scope;
  }

  releaseSessionScope(scope: SessionScope): void {
    if (this.scope?.scopeKey === scope.scopeKey) this.scope = undefined;
  }

  private requireScope(): SessionScope {
    if (!this.scope) throw new Error('Team management requires an admitted session scope.');
    return this.scope;
  }

  private sessionJobs(): TrackedAsyncJobsContract {
    const scope = this.requireScope();
    return this.jobs.forSession(scope.rootSessionId, scope);
  }

  private resolveJob(id: string): TrackedAsyncJob | undefined {
    const runs = this.sessionJobs().list();
    const exact = runs.find((run) => run.runId === id);
    if (exact) return exact;
    const matches = runs.filter((run) => run.runId.startsWith(id));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new DoomTeamExpectedError(
        'run_not_found',
        `Multiple current-session runs match '${id}'.`,
        false,
        'Retry with a longer run id.',
      );
    }
    return undefined;
  }

  private requireActiveJob(id: string): TrackedAsyncJob {
    const job = this.resolveJob(id);
    if (!job) {
      throw new DoomTeamExpectedError(
        'run_not_found',
        `No active run matches '${id}'.`,
        false,
        'Call subagent({"action":"status"}) and retry with an exact run id.',
      );
    }
    return job;
  }

  status(id: string): StatusActionResult {
    const job = this.resolveJob(id);
    return {
      runId: job?.runId ?? id,
      runDir: undefined,
      resultPath: undefined,
      claimed: false,
      status: job ? statusProjection(job) : undefined,
    };
  }

  async statusAsync(id: string): Promise<StatusActionResult> {
    return this.status(id);
  }

  list(): ListActionResult {
    return { runs: this.sessionJobs().list() };
  }

  async interrupt(id: string, reason?: string): Promise<ControlActionResult> {
    return this.stopWithCommand(id, 'interrupt', reason);
  }

  async stop(id: string, reason?: string): Promise<ControlActionResult> {
    return this.stopWithCommand(id, 'stop', reason);
  }

  private async stopWithCommand(
    id: string,
    command: 'interrupt' | 'stop',
    reason?: string,
  ): Promise<ControlActionResult> {
    const scope = this.requireScope();
    const job = this.requireActiveJob(id);
    const requestId = randomUUID();
    if (job.native) {
      if (!this.nativeRuns?.get(scope.rootSessionId, job.runId)) {
        throw new DoomTeamExpectedError(
          'run_not_found',
          `Native run '${job.runId}' is no longer active.`,
          false,
          'List active runs and retry with a current run id.',
        );
      }
      await this.nativeRuns.stop(scope.rootSessionId, job.runId, reason);
      return { requestId };
    }
    if (!this.externalProcesses?.has(scope, job.runId)) {
      throw new DoomTeamExpectedError(
        'run_not_found',
        `External run '${job.runId}' is no longer active.`,
        false,
        'List active runs and retry with a current run id.',
      );
    }
    await this.externalProcesses.control(scope, job.runId, { command, requestId, ...(reason ? { reason } : {}) });
    return { requestId };
  }

  async steer(id: string, message: string, targetIndex?: number, signal?: AbortSignal): Promise<SteerActionResult> {
    const scope = this.requireScope();
    const job = this.requireActiveJob(id);
    const requestId = randomUUID();
    const index = targetIndex ?? 0;
    if (job.native) {
      if (!this.nativeRuns?.get(scope.rootSessionId, job.runId)) {
        throw new DoomTeamExpectedError(
          'run_not_found',
          `Native run '${job.runId}' is no longer active.`,
          false,
          'List active runs and retry with a current run id.',
        );
      }
      await this.nativeRuns.steer(scope.rootSessionId, job.runId, message, signal);
      return { requestId, index, state: 'delivered', message: 'Native child accepted the steer request.' };
    }
    if (!this.externalProcesses?.has(scope, job.runId)) {
      throw new DoomTeamExpectedError(
        'run_not_found',
        `External run '${job.runId}' is no longer active.`,
        false,
        'List active runs and retry with a current run id.',
      );
    }
    const acknowledgement = await this.externalProcesses.control(scope, job.runId, {
      command: 'steer',
      requestId,
      message,
      targetIndex: index,
    });
    if (!acknowledgement) {
      return { requestId, index, state: 'pending', message: 'No child acknowledgment arrived within 3 seconds.' };
    }
    return {
      requestId,
      index,
      state: acknowledgement.state,
      message: acknowledgement.message,
    };
  }
}
