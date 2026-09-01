/**
 * Serves `doom-task` through Team's session-bound delegation service: turn a
 * request into a spawned run, report its progress, and settle it exactly once.
 *
 * WHY THIS IS NOT IN `pi.ts`:
 * It used to be, inline, and it was the single largest reason that file failed
 * `thin-pi-adapter`: roughly 250 lines of orchestration, state and protocol
 * handling sitting in what should be a lifecycle shim. None of it is Pi
 * lifecycle - it is a request/response state machine that happens to be started
 * from one. Here it is testable without activating an extension.
 *
 * SETTLING EXACTLY ONCE IS THE WHOLE CONTRACT:
 * A delegation can be finished by four racing paths - the run completing, the
 * wait timing out, an explicit cancel, and a session teardown. `finish()` is
 * the only writer, guarded by the request's own `settled` flag, so whichever
 * arrives first wins and the rest are no-ops. `settledRequestIds` then keeps a
 * bounded memory of what already finished, because a late duplicate request
 * for an id that has already settled must not start a second run.
 *
 * AVOID:
 * - Publishing a terminal event from anywhere but `finish()`
 * - Letting the settled set grow without bound; it is a dedupe window, not a
 *   ledger
 */

import {
  DelegationCancelSchema,
  DOOM_DELEGATION_ACCEPTED_EVENT,
  DOOM_DELEGATION_CANCELLED_EVENT,
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_STARTED_EVENT,
  DOOM_DELEGATION_UPDATED_EVENT,
  DOOM_DELEGATION_REQUESTED_EVENT,
  type DoomDelegationService,
  type DelegationRequest,
  DelegationRequestSchema,
  type DelegationResult,
} from '@agimon-ai/doompi-extension-contracts/delegation';
import type { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';

import type { AsyncJobTrackerContract, TrackedAsyncJobsContract } from '../../asyncJobTracker';
import type { SubagentWaiterContract } from '../../runs/background/subagentWait';
import type { AvailableModelInfo, ParentModel } from '../../runs/shared/modelFallback';
import type { PollSchedulerContract } from '../../pollScheduler';
import type { ExtensionConfig } from './config';
import type { ManagementActionsContract } from './managementActions';
import type { SpawnPlannerContract, SessionForkSource } from './spawnPlan';

const DEFAULT_DELEGATION_TIMEOUT_MS = 20 * 60 * 1000;
const DELEGATION_PROGRESS_INTERVAL_MS = 250;
const SETTLED_DELEGATION_WINDOW = 256;

/**
 * Terminal states, named because they are an external contract with
 * `doom-task`'s `DelegationManager`, which branches on the exact strings.
 */
const STATUS_COMPLETED = 'completed';
const STATUS_CANCELLED = 'cancelled';
const STATUS_FAILED = 'failed';
const STATUS_TIMED_OUT = 'timed_out';
const FAILED_RUN_ID_PREFIX = 'failed:';
const CANCELLED_RUN_ID_PREFIX = 'cancelled:';

interface ActiveDelegation {
  requestId: string;
  taskId: string | number;
  controller: AbortController;
  runId?: string;
  /** Wall-clock start captured after the child has been acknowledged. */
  runtimeStartedAt?: number;
  cancelRequested: boolean;
  settled: boolean;
  disposeProgress?: () => void;
}

/** What the bridge needs from the session it is bound to, read fresh per call. */
export interface DelegationSessionContext {
  sessionId: string;
  availableModels: AvailableModelInfo[];
  parentModel?: ParentModel;
  /**
   * Read fresh per delegation request. Never cached: Pi does not persist a
   * transcript until the session's first assistant message, so a value captured
   * when the session binds is empty for a new session and stale after a resume.
   */
  captureForkSource?: () => SessionForkSource | undefined;
}

export interface DelegationBridgeDeps {
  planner: SpawnPlannerContract;
  management: ManagementActionsContract;
  waiter: SubagentWaiterContract;
  scheduler: PollSchedulerContract;
  tracker: AsyncJobTrackerContract;
  loadConfig: () => ExtensionConfig;
}

export interface DelegationBridge {
  /** Create the generation-bound service published for one Team session. */
  createService(ctx: Context, session: DelegationSessionContext): DoomDelegationService;
  /** Abandon every in-flight delegation without notifying, for a session teardown. */
  abandonAll(): void;
}

export function createDelegationBridge(deps: DelegationBridgeDeps): DelegationBridge {
  const active = new Map<string, ActiveDelegation>();
  const settledRequestIds = new Set<string>();

  const rememberSettled = (requestId: string): void => {
    settledRequestIds.add(requestId);
    if (settledRequestIds.size > SETTLED_DELEGATION_WINDOW) {
      settledRequestIds.delete(settledRequestIds.values().next().value as string);
    }
  };

  /** The one writer of a terminal outcome. See the module header. */
  const finish = (entry: ActiveDelegation, result: DelegationResult, ctx: Context): void => {
    if (entry.settled) return;
    entry.settled = true;
    entry.disposeProgress?.();
    active.delete(entry.requestId);
    rememberSettled(entry.requestId);
    ctx.emit(DOOM_DELEGATION_FINISHED_EVENT, result);
  };

  /** Ask the run to stop. Returns the failure message when the request itself failed. */
  const stop = (entry: ActiveDelegation, reason: string): string | undefined => {
    if (!entry.runId) return undefined;
    try {
      deps.management.stop(entry.runId, reason);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const monitor = async (
    entry: ActiveDelegation,
    request: DelegationRequest,
    ctx: Context,
    jobs: TrackedAsyncJobsContract,
    sessionId: string,
  ): Promise<void> => {
    const runId = entry.runId;
    if (!runId) return;

    let lastProgress = '';
    entry.disposeProgress = deps.scheduler.register({
      id: `delegation:${entry.requestId}`,
      intervalMs: DELEGATION_PROGRESS_INTERVAL_MS,
      run: () => {
        const job = jobs.get(runId);
        if (!job) return false;
        const progressKey = [job.status, job.updatedAt, job.error, job.tokens, job.currentTool, job.toolCount]
          .map((value) => String(value))
          .join(':');
        if (progressKey === lastProgress) return false;
        lastProgress = progressKey;
        ctx.emit(DOOM_DELEGATION_UPDATED_EVENT, {
          requestId: entry.requestId,
          runId,
          ...(job.status !== undefined ? { status: job.status } : {}),
          ...(entry.runtimeStartedAt !== undefined
            ? { durationMs: Math.max(0, Date.now() - entry.runtimeStartedAt) }
            : {}),
          ...(job.tokens !== undefined ? { tokens: job.tokens } : {}),
          ...(job.currentTool !== undefined ? { currentTool: job.currentTool } : {}),
          ...(job.toolCount !== undefined ? { toolCount: job.toolCount } : {}),
        });
        return true;
      },
    });
    deps.scheduler.wake();

    const timeoutMs = request.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
    const wait = await deps.waiter.wait({
      target: { id: runId },
      sessionId,
      waitFor: 'completion',
      timeoutMs,
      signal: entry.controller.signal,
    });
    if (entry.settled) return;

    if (wait.reason === 'timeout') {
      const stopError = stop(entry, 'Delegation timed out.');
      finish(
        entry,
        {
          requestId: entry.requestId,
          runId,
          status: STATUS_TIMED_OUT,
          error: stopError ?? `Delegation produced no result within ${timeoutMs}ms`,
          durationMs: wait.elapsedMs,
        },
        ctx,
      );
      return;
    }
    if (wait.reason === 'aborted' || entry.cancelRequested) {
      finish(entry, { requestId: entry.requestId, runId, status: STATUS_CANCELLED, durationMs: wait.elapsedMs }, ctx);
      return;
    }
    if (wait.reason !== 'completed') {
      finish(
        entry,
        {
          requestId: entry.requestId,
          runId,
          status: STATUS_FAILED,
          error: `Delegation wait ended with ${wait.reason}.`,
          durationMs: wait.elapsedMs,
        },
        ctx,
      );
      return;
    }

    const status = deps.management.status(runId).status;
    const completed = status?.state === 'complete' || status?.state === STATUS_COMPLETED;
    const cancelled = status?.state === 'stopped' && entry.cancelRequested;
    finish(
      entry,
      {
        requestId: entry.requestId,
        runId,
        status: completed ? STATUS_COMPLETED : cancelled ? STATUS_CANCELLED : STATUS_FAILED,
        ...(status?.summary ? { output: status.summary } : {}),
        ...(status?.error ? { error: status.error } : {}),
        ...(status?.sessionFile ? { sessionFile: status.sessionFile } : {}),
        durationMs:
          status?.endedAt && status.startedAt ? Math.max(0, status.endedAt - status.startedAt) : wait.elapsedMs,
      },
      ctx,
    );
  };

  const onRequested = async (
    request: DelegationRequest,
    ctx: Context,
    session: DelegationSessionContext,
  ): Promise<void> => {
    if (active.has(request.requestId) || settledRequestIds.has(request.requestId)) return;
    const entry: ActiveDelegation = {
      requestId: request.requestId,
      taskId: request.taskId,
      controller: new AbortController(),
      cancelRequested: false,
      settled: false,
    };
    active.set(request.requestId, entry);
    ctx.emit(DOOM_DELEGATION_ACCEPTED_EVENT, { requestId: request.requestId });

    try {
      const forkSource = session.captureForkSource?.();
      const result = await deps.planner.spawn(
        {
          single: {
            agent: request.agent,
            ...(request.inlineAgent ? { inlineAgent: request.inlineAgent } : {}),
            task: request.prompt,
            model: request.model,
            ...(request.context ? { context: request.context } : {}),
          },
          cwd: request.cwd,
          agentScope: 'both',
          parentSessionId: session.sessionId,
          ...(forkSource ? { parentSessionFile: forkSource.sessionFile, parentLeafId: forkSource.leafId } : {}),
          availableModels: session.availableModels,
          ...(session.parentModel ? { parentModel: session.parentModel } : {}),
        },
        deps.loadConfig(),
      );
      const outcome = result.outcomes[0];
      if (!outcome?.runId) {
        finish(
          entry,
          {
            requestId: request.requestId,
            runId: `${FAILED_RUN_ID_PREFIX}${String(request.taskId)}`,
            status: STATUS_FAILED,
            error: outcome?.error ?? 'Delegation did not start.',
          },
          ctx,
        );
        return;
      }

      entry.runId = outcome.runId;
      const jobs = deps.tracker.forSession(session.sessionId);
      jobs.track(outcome.runId);
      // A cancel that landed while the spawn was in flight already settled this
      // entry; the run exists now, so it has to be stopped rather than tracked.
      if (entry.settled) {
        stop(entry, 'Delegation was cancelled before launch completed.');
        return;
      }
      entry.runtimeStartedAt = Date.now();
      ctx.emit(DOOM_DELEGATION_STARTED_EVENT, { requestId: request.requestId, runId: outcome.runId });
      await monitor(entry, request, ctx, jobs, session.sessionId);
    } catch (error) {
      finish(
        entry,
        {
          requestId: request.requestId,
          runId: entry.runId ?? `${FAILED_RUN_ID_PREFIX}${String(request.taskId)}`,
          status: STATUS_FAILED,
          error: error instanceof Error ? error.message : String(error),
        },
        ctx,
      );
    }
  };

  const onCancelled = (requestId: string, reason: string | undefined, ctx: Context): void => {
    const entry = active.get(requestId);
    if (!entry || entry.settled) return;
    entry.cancelRequested = true;
    const stopError = stop(entry, reason ?? 'Delegation cancelled by requester.');
    entry.controller.abort();
    finish(
      entry,
      {
        requestId,
        runId: entry.runId ?? `${CANCELLED_RUN_ID_PREFIX}${String(entry.taskId)}`,
        status: STATUS_CANCELLED,
        ...(stopError ? { error: stopError } : {}),
      },
      ctx,
    );
  };

  return {
    createService(ctx, session) {
      const service: DoomDelegationService = {
        sessionId: session.sessionId,
        generation: `doom-delegation:${crypto.randomUUID()}`,
        async request(request) {
          if (!Check(DelegationRequestSchema, request)) throw new TypeError('Invalid delegation request.');
          ctx.emit(DOOM_DELEGATION_REQUESTED_EVENT, request);
          await onRequested(request, ctx, session);
        },
        cancel(request) {
          if (!Check(DelegationCancelSchema, request)) throw new TypeError('Invalid delegation cancel request.');
          ctx.emit(DOOM_DELEGATION_CANCELLED_EVENT, request);
          onCancelled(request.requestId, request.reason, ctx);
        },
      };
      return Object.freeze(service);
    },

    /**
     * Teardown, not cancellation: the requester is going away with us, so there
     * is nobody left to notify. Marked settled first so an in-flight `monitor`
     * that wakes during shutdown finds the entry closed and stays quiet.
     */
    abandonAll() {
      for (const entry of active.values()) {
        entry.settled = true;
        entry.controller.abort();
        entry.disposeProgress?.();
      }
      active.clear();
      settledRequestIds.clear();
    },
  };
}
