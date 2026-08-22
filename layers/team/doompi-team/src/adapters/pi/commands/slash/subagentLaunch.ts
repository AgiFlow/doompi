/**
 * Launches a subagent spawn from a slash command and tracks the result,
 * plus the stop path for cancelling one. Replaces the predecessor's
 * `slash-bridge.ts`.
 *
 * WHY THE EVENT BUS IS GONE:
 * The predecessor's `registerSlashSubagentBridge` was one of three bridges
 * (`registerSlashSubagentBridge`, `registerSubagentRpcBridge`,
 * `registerPromptTemplateDelegationBridge`) sharing one `pi.events` channel
 * into one foreground executor, so decoupling was load-bearing there. In
 * this package, only the slash layer calls into `SpawnPlanner` today - no
 * RPC bridge exists, and the delegation bridge is out of scope (see
 * `nested-events.ts`'s and this port's own precedent for not building
 * infrastructure a second consumer does not exist to use yet). A command
 * handler resolves `SpawnPlanner` and calls it directly.
 *
 * WHY THIS DOES NOT AWAIT COMPLETION FOR SINGLE/PARALLEL:
 * `SpawnPlanner.spawn()`'s own contract (see `spawnPlan.ts`) resolves once
 * each child confirms it started, not once it finishes -
 * `SpawnPlanChildOutcome.summary` stays `undefined` for exactly that reason.
 * This package is async-only: a slash command that instead blocked until
 * completion would reintroduce the foreground model through the back door.
 * `launchChainSubagents` is the one exception, and deliberately not
 * refactored to match: CHAIN mode has to wait for each step to resolve
 * `{previous}`/`{outputs.name}` before starting the next one, so awaiting
 * `spawnChain()` is chain mode's own real shape, not a leftover synchronous
 * branch.
 *
 * WHY `AsyncJobTracker`, NOT A NEW POLLER:
 * `AsyncJobTracker`'s own module doc already deferred "TUI rendering" to
 * this package's slash+TUI port. `watchTrackedRunUntilTerminal` below reads
 * from it and registers with `PollScheduler` (the one master tick every
 * other watcher in this package uses) rather than owning a private timer or
 * a loop that polls and self-terminates. The render-key gate (only calling
 * `onChange` when the tracked job's status/updatedAt/activityState actually
 * changed) is the fix for the predecessor's fleet-view bug this package
 * exists to remove - re-rendering, and re-reading, only on real change - and
 * unregistering once terminal is a structural property of the subscription
 * itself, not a condition checked inside a loop this module owns.
 *
 * WHY A STOP-REQUEST FAILURE IS NOT SWALLOWED:
 * `requestAsyncInterrupt`/`requestAsyncStop` are synchronous and already
 * propagate a write failure by throwing; `requestSlashRunStop` does not
 * wrap them in a try/catch. The actual stop still happens out-of-band in
 * whichever process owns the run - "fire-and-forget" describes that
 * asynchrony, not permission to lose a failed write silently. Same
 * distinction `control-channel.ts`'s `removeIfPresent` draws between a
 * missing file (benign) and a real error (must propagate).
 *
 * AVOID:
 * - Awaiting `spawn()` for a result that will not exist yet. See above
 * - A bare `try { requestSlashRunStop(...) } catch {}` at any call site
 * - A private `setInterval`/`setTimeout` loop for polling a tracked run.
 *   Register with `PollScheduler` instead
 */

import * as path from 'node:path';
import type { ExtensionConfig } from '../../extensions/config';
import type {
  SpawnPlannerContract,
  SpawnPlanChildOutcome,
  SpawnPlanResult,
  SpawnPlanTaskInput,
} from '../../extensions/spawnPlan';
import type { AgentScope } from '../../../agents/types';
import { requestAsyncInterrupt, requestAsyncStop } from '../../../intercom/supervisorControlChannel';
import {
  type TrackedAsyncJobsContract,
  TERMINAL_ASYNC_JOB_STATES,
  type TrackedAsyncJob,
} from '../../../asyncJobTracker';
import type { AvailableModelInfo, ParentModel } from '../../../runs/shared/modelFallback';
import { currentRunsDir } from '../../../filesystem/paths';
import type { PollSchedulerContract } from '../../../pollScheduler';

export interface SlashSingleLaunchInput {
  agent: string;
  task: string;
  cwd: string;
  agentScope: AgentScope;
  model?: string;
  context?: 'fresh' | 'fork';
  parentSessionId?: string;
  currentDepth?: number;
  availableModels?: AvailableModelInfo[];
  parentModel?: ParentModel;
  parentSessionFile?: string;
  parentLeafId?: string;
}

export interface SlashParallelLaunchInput {
  tasks: SpawnPlanTaskInput[];
  cwd: string;
  agentScope: AgentScope;
  concurrency?: number;
  parentSessionId?: string;
  currentDepth?: number;
  availableModels?: AvailableModelInfo[];
  parentModel?: ParentModel;
  parentSessionFile?: string;
  parentLeafId?: string;
}

function trackLaunchedRuns(tracker: TrackedAsyncJobsContract, outcomes: SpawnPlanChildOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.runId) tracker.track(outcome.runId);
  }
}

/** SINGLE mode: fires one child, returns once it has started, and tracks it for live display. */
export async function launchSingleSubagent(
  planner: SpawnPlannerContract,
  tracker: TrackedAsyncJobsContract,
  input: SlashSingleLaunchInput,
  config: ExtensionConfig,
): Promise<SpawnPlanResult> {
  const result = await planner.spawn(
    {
      single: {
        agent: input.agent,
        task: input.task,
        ...(input.model ? { model: input.model } : {}),
        ...(input.context ? { context: input.context } : {}),
      },
      cwd: input.cwd,
      agentScope: input.agentScope,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.currentDepth !== undefined ? { currentDepth: input.currentDepth } : {}),
      ...(input.availableModels !== undefined ? { availableModels: input.availableModels } : {}),
      ...(input.parentModel ? { parentModel: input.parentModel } : {}),
      ...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
      ...(input.parentLeafId ? { parentLeafId: input.parentLeafId } : {}),
    },
    config,
  );
  trackLaunchedRuns(tracker, result.outcomes);
  return result;
}

/** PARALLEL mode: fans out N children, returns once each has started, and tracks every one for live display. */
export async function launchParallelSubagents(
  planner: SpawnPlannerContract,
  tracker: TrackedAsyncJobsContract,
  input: SlashParallelLaunchInput,
  config: ExtensionConfig,
): Promise<SpawnPlanResult> {
  const result = await planner.spawn(
    {
      tasks: input.tasks,
      cwd: input.cwd,
      agentScope: input.agentScope,
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.currentDepth !== undefined ? { currentDepth: input.currentDepth } : {}),
      ...(input.availableModels !== undefined ? { availableModels: input.availableModels } : {}),
      ...(input.parentModel ? { parentModel: input.parentModel } : {}),
      ...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
      ...(input.parentLeafId ? { parentLeafId: input.parentLeafId } : {}),
    },
    config,
  );
  trackLaunchedRuns(tracker, result.outcomes);
  return result;
}

export type SlashStopMode = 'interrupt' | 'stop';

/**
 * Ask a tracked run to stop. See the module doc: a write failure here is a
 * real failure and is NOT caught - the caller must surface it.
 */
export function requestSlashRunStop(runId: string, mode: SlashStopMode = 'stop', reason?: string): void {
  const asyncDir = path.join(currentRunsDir(), runId);
  const payload = reason ? { reason } : {};
  if (mode === 'interrupt') requestAsyncInterrupt(asyncDir, payload);
  else requestAsyncStop(asyncDir, payload);
}

export interface SlashRunWatchOptions {
  intervalMs?: number;
}

const DEFAULT_SLASH_RUN_WATCH_INTERVAL_MS = 500;

function renderKeyFor(job: TrackedAsyncJob | undefined): string {
  if (!job) return 'untracked';
  return `${job.status ?? ''}:${job.updatedAt ?? ''}:${job.activityState ?? ''}:${job.attentionReason ?? ''}`;
}

/**
 * Call `onChange` only when a tracked run's status actually changes, and
 * stop watching once it reaches a terminal state - a structural property of
 * unregistering from `PollScheduler`, not a condition checked inside a loop
 * this function owns. See the module doc's `AsyncJobTracker`/`PollScheduler`
 * section for why.
 *
 * Returns an unregister function; call it to stop watching early (e.g. the
 * caller navigated away from the message before the run finished).
 */
export function watchTrackedRunUntilTerminal(
  scheduler: PollSchedulerContract,
  tracker: TrackedAsyncJobsContract,
  runId: string,
  onChange: (job: TrackedAsyncJob | undefined) => void,
  options: SlashRunWatchOptions = {},
): () => void {
  let unregister: (() => void) | undefined;
  let lastRenderKey: string | undefined;

  const check = (): boolean => {
    const job = tracker.get(runId);
    const key = renderKeyFor(job);
    if (key === lastRenderKey) return false;
    lastRenderKey = key;
    onChange(job);
    if (job?.status !== undefined && TERMINAL_ASYNC_JOB_STATES.has(job.status)) unregister?.();
    return true;
  };

  unregister = scheduler.register({
    id: `slash-run-watch-${runId}`,
    intervalMs: options.intervalMs ?? DEFAULT_SLASH_RUN_WATCH_INTERVAL_MS,
    run: check,
  });
  return unregister;
}
