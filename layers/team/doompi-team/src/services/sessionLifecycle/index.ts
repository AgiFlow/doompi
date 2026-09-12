import type { TrackedAsyncJob } from '../asyncJobTracker';
import type { SessionScope } from '../sessionPaths';
import { listSuspendedRuns, listSuspendedRunsAsync, type SuspendedRun, suspendRun } from '../suspendedRuns';

export interface SuspendScopeOptions {
  scope: SessionScope;
  reason: string;
  jobs: readonly TrackedAsyncJob[];
  stop: (runId: string, reason: string) => Promise<unknown>;
  now?: () => number;
}

export interface SuspendScopeResult {
  suspended: string[];
  unstoppable: string[];
}

function active(job: TrackedAsyncJob): boolean {
  return job.status === undefined || !new Set(['complete', 'completed', 'failed', 'paused', 'stopped']).has(job.status);
}

function suspendedRecord(job: TrackedAsyncJob, reason: string, suspendedAt: number): Omit<SuspendedRun, 'version'> {
  return {
    runId: job.runId,
    agent: job.agent ?? 'unknown',
    runtime: job.runtime ?? (job.native ? 'pi' : 'external'),
    task: job.task ?? '',
    cwd: job.cwd ?? '',
    ...(job.status === undefined ? {} : { lastStatus: job.status }),
    ...(job.sessionFile === undefined ? {} : { sessionFile: job.sessionFile }),
    suspendedAt,
    reason,
  };
}

/** Persist resumable metadata, then stop every live run through its typed owner. */
export async function suspendScopeRuns(options: SuspendScopeOptions): Promise<SuspendScopeResult> {
  const jobs = options.jobs.filter(active);
  const suspendedAt = options.now?.() ?? Date.now();
  for (const job of jobs) suspendRun(options.scope, suspendedRecord(job, options.reason, suspendedAt));
  const outcomes = await Promise.allSettled(jobs.map((job) => options.stop(job.runId, options.reason)));
  return {
    suspended: jobs.map((job) => job.runId),
    unstoppable: jobs.filter((_, index) => outcomes[index]?.status === 'rejected').map((job) => job.runId),
  };
}

export interface OpenScopeResult {
  pruned: string[];
  reaped: number;
  suspended: SuspendedRun[];
}

/** Durable suspended records are history only. They never seed current live state. */
export function openScope(scope: SessionScope): OpenScopeResult {
  return { pruned: [], reaped: 0, suspended: listSuspendedRuns(scope) };
}

/** Async form used by session startup. */
export async function openScopeAsync(scope: SessionScope): Promise<OpenScopeResult> {
  return { pruned: [], reaped: 0, suspended: await listSuspendedRunsAsync(scope) };
}
