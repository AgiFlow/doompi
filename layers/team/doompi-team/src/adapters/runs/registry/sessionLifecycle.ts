/**
 * What happens to this scope's runs when a session starts or ends.
 *
 * Two operations, deliberately kept out of the extension's activation function
 * so both are testable without a Pi host:
 *
 * - `suspendScopeRuns` on every shutdown: stop each recorded run's process
 *   group and write down enough to start it again.
 * - `openScope` on every start: prune records whose process is gone, reap
 *   sibling scopes that hold nothing alive, and report what is suspended
 *   WITHOUT restoring any of it.
 *
 * WHY SHUTDOWN DOES NOT BRANCH ON `reason`:
 * See `suspendedRuns.ts`. Uniform beats one remembered exception, and restore
 * is cheap because a Pi child continues its own transcript.
 *
 * AVOID:
 * - Restoring from here. `openScope` reports; something explicit restores
 */

import { type SessionScope } from '../../filesystem/paths';
import type { AsyncRunStatus } from '../background/asyncExecution';
import { type ProcessGroupSignals, stopProcessGroup } from './processGroup';
import {
  defaultPidLiveness,
  findReapableScopes,
  findReapableScopesAsync,
  listRuns,
  listRunsAsync,
  type PidLivenessProbe,
  pruneDeadRuns,
  pruneDeadRunsAsync,
  type RunRecord,
  reapScope,
  reapScopeAsync,
  releaseRun,
} from '../../runRegistry';
import {
  listSuspendedRuns,
  listSuspendedRunsAsync,
  type SuspendedRun,
  suspendRun,
  suspendRunAsync,
} from '../../suspendedRuns';

const PARENT_LOST_REASON = 'parent_lost';

/** Reads a run's own status, so a suspended record can carry its last known state. */
export type RunStatusReader = (runId: string) => AsyncRunStatus | undefined;

export interface SuspendScopeOptions {
  scope: SessionScope;
  /** Pi's `session_shutdown` reason, recorded so a later report can say why. */
  reason: string;
  readStatus: RunStatusReader;
  now?: () => number;
  signals?: ProcessGroupSignals;
  graceMs?: number;
}

export interface SuspendScopeResult {
  suspended: string[];
  /** Runs whose group survived even SIGKILL. Should be empty; reported rather than assumed. */
  unstoppable: string[];
}

function toSuspendedRecord(run: RunRecord, status: AsyncRunStatus | undefined, reason: string, at: number) {
  return {
    runId: run.runId,
    agent: run.agent,
    runtime: run.runtime,
    task: status?.task ?? '',
    cwd: status?.cwd ?? process.cwd(),
    ...(status?.model ? { model: status.model } : {}),
    ...(status?.inlineAgent ? { inlineAgent: status.inlineAgent } : {}),
    ...(status?.summary ? { lastStatus: status.state } : status?.state ? { lastStatus: status.state } : {}),
    ...(status?.sessionFile ? { sessionFile: status.sessionFile } : {}),
    suspendedAt: at,
    reason,
  };
}

/**
 * Stop every run this scope owns and record how to bring it back.
 *
 * The record is written BEFORE the signal: a process that dies between the two
 * leaves a restorable record, whereas the other order can lose the run
 * entirely if the parent is killed mid-sweep.
 */
export async function suspendScopeRuns(options: SuspendScopeOptions): Promise<SuspendScopeResult> {
  const at = options.now?.() ?? Date.now();
  const runs = listRuns(options.scope);
  const suspended: string[] = [];

  // Pi does not await session_shutdown handlers. Persist every run before the
  // first async wait so process exit cannot truncate this sweep after one run.
  for (const run of runs) {
    suspendRun(options.scope, toSuspendedRecord(run, options.readStatus(run.runId), options.reason, at));
    suspended.push(run.runId);
  }

  // Starting all async stop operations in one map dispatches every initial
  // SIGTERM synchronously before any grace-period promise is awaited.
  const stopResults = await Promise.all(
    runs.map(async (run) => {
      const stopped = await stopProcessGroup(run.pid, options.graceMs, options.signals);
      releaseRun(options.scope, run.runId);
      return { runId: run.runId, stopped };
    }),
  );
  const unstoppable = stopResults.filter((result) => !result.stopped).map((result) => result.runId);

  return { suspended, unstoppable };
}

export interface OpenScopeResult {
  /** Run ids whose process was already gone; their records were dropped. */
  pruned: string[];
  /** Sibling scopes removed because nothing in them was alive. */
  reaped: number;
  /** Suspended runs awaiting an explicit restore. Reported, never started here. */
  suspended: SuspendedRun[];
}

export interface OpenScopeOptions {
  isAlive?: PidLivenessProbe;
  readStatus?: RunStatusReader;
  readStatusAsync?: (runId: string) => Promise<AsyncRunStatus | undefined>;
  now?: () => number;
}

export function openScope(scope: SessionScope, options: OpenScopeOptions = {}): OpenScopeResult {
  const isAlive = options.isAlive ?? defaultPidLiveness;
  const alreadySuspended = new Set(listSuspendedRuns(scope).map((run) => run.runId));
  const at = options.now?.() ?? Date.now();
  for (const run of listRuns(scope)) {
    if (isAlive(run.pid) || alreadySuspended.has(run.runId)) continue;
    suspendRun(scope, toSuspendedRecord(run, options.readStatus?.(run.runId), PARENT_LOST_REASON, at));
  }

  const pruned = pruneDeadRuns(scope, isAlive);
  const reapable = findReapableScopes(scope, isAlive);
  for (const stale of reapable) reapScope(stale);
  return { pruned, reaped: reapable.length, suspended: listSuspendedRuns(scope) };
}

export async function openScopeAsync(scope: SessionScope, options: OpenScopeOptions = {}): Promise<OpenScopeResult> {
  const isAlive = options.isAlive ?? defaultPidLiveness;
  const alreadySuspended = new Set((await listSuspendedRunsAsync(scope)).map((run) => run.runId));
  const at = options.now?.() ?? Date.now();
  for (const run of await listRunsAsync(scope)) {
    if (isAlive(run.pid) || alreadySuspended.has(run.runId)) continue;
    const status = options.readStatusAsync ? await options.readStatusAsync(run.runId) : options.readStatus?.(run.runId);
    await suspendRunAsync(scope, toSuspendedRecord(run, status, PARENT_LOST_REASON, at));
  }

  const pruned = await pruneDeadRunsAsync(scope, isAlive);
  const reapable = await findReapableScopesAsync(scope, isAlive);
  await Promise.all(reapable.map((stale) => reapScopeAsync(stale)));
  return { pruned, reaped: reapable.length, suspended: await listSuspendedRunsAsync(scope) };
}
