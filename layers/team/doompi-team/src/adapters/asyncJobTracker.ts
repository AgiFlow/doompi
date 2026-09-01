/**
 * Live, in-memory registry of the async runs this session currently cares
 * about, refreshed from `status.json` on a `PollScheduler` tick.
 *
 * WHY THIS IS SMALLER THAN THE PREDECESSOR:
 * `doom-pi-subagents/src/runs/background/asyncJobTracker.ts` is 590 lines
 * doing four different jobs: this registry, TUI widget rendering
 * (`renderWidget`/`widgetRenderKey`/`ctx.ui.requestRender`), forwarding
 * control events and steering notices by byte-range-tailing each run's
 * `events.jsonl`, and projecting nested/parallel-group run trees. Only the
 * registry is ported. The other three have no consumer in this package yet:
 * TUI rendering is `G8` (slash commands + TUI), and nested/chain/parallel run
 * modes are `G7`+ (this package is currently single-run async-only - see
 * `spawnHandshake.ts`'s header). Porting rendering or event-tailing logic
 * with nothing to render to or forward to would be untested, unreachable
 * code; it is deferred to whichever later port actually needs it, not
 * dropped silently - this note is where to look for it.
 *
 * DESIGN PATTERNS:
 * - The in-memory map is a pure CACHE, never authoritative on its own:
 *   `status.json` (owned by `CoalescedStatusWriter` elsewhere) is the only
 *   source of truth. `track()` reads it synchronously immediately, so a
 *   caller that already knows a run's id sees *something* right away rather
 *   than waiting out the first poll
 * - Restart survivability follows from the point above rather than a second
 *   persistence layer: this package has not built session-scoped run
 *   ownership yet (which ids "belong" to a restarted session is not
 *   something this module can determine on its own - see the AVOID entry),
 *   so recovery is the caller re-`track()`-ing whatever ids it still cares
 *   about from ITS OWN durable record. The very next poll tick repopulates
 *   that job's status straight from disk. There is no separate store to keep
 *   in sync, and therefore no window where memory could diverge from disk
 *   that a restart would not immediately close
 * - Registered with `PollScheduler`, not a private timer: this polls
 *   potentially many jobs' status files on an unbounded, periodic cadence
 *   with no low-latency requirement - the exact shape `PollScheduler` exists
 *   for. Contrast `completionBatcher.ts`/`spawnHandshake.ts`, which own
 *   their own timers because they are short-lived, single-shot, and need
 *   sub-200ms responsiveness `PollScheduler`'s floor cannot give them; this
 *   registry needs neither
 * - Retention-then-eviction happens on the SAME poll tick as the status
 *   refresh, rather than the predecessor's per-job `setTimeout`
 *   (`scheduleCleanup`): a terminal job aged past `retentionMs` is simply
 *   dropped the next time `run()` walks the map. One clock, not one timer per
 *   job
 *
 * AVOID:
 * - Scanning `currentRunsDir()` to guess which run ids "belong" to this session on
 *   startup. This package has no session-scoped run ownership concept yet;
 *   inventing one here to answer "what should I restore" would be a guess,
 *   not a fact this module has standing to assert. Restoration is the
 *   caller's job (see the design note above)
 * - Growing `terminalStates` independently of `staleRunReconciler.ts`'s own
 *   (unexported) copy; both must treat the same state strings as terminal,
 *   or a job could be evicted here while the reconciler still thinks it is
 *   in flight, or vice versa
 *
 * `activityState`/`attentionReason` (added for `subagentWait.ts`):
 * `DeliverableGuard.evaluate()` computes `activityState: 'needs_attention'`
 * and a `reason` (e.g. `'missing-deliverable'`), but returns it rather than
 * writing it anywhere - it has no standing to touch `status.json` itself (see
 * that module's header). Something upstream of this tracker - the run's own
 * runner main loop, not yet built - is responsible for folding that result
 * into `status.json` through `CoalescedStatusWriter`. This tracker's job is
 * only to read whatever ends up there, the same as every other field: it does
 * not compute attention, detect it, or decide when a run needs it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAsyncRunStatus } from './statusReader';
import { STATUS_FILE_NAME } from './runs/background/statusWriter';
import { currentRunsDir } from './filesystem/paths';
import type { PollSchedulerContract } from './pollScheduler';
import type { ActivityState } from '../types';

/**
 * States that mean "already finished"; matches `staleRunReconciler.ts`'s
 * own (unexported) set. Exported so a caller outside this module (the slash
 * layer's poll-until-terminal helper) can recognize the same terminal set
 * `TrackedAsyncJob.status` uses, rather than declaring a third copy of this
 * literal.
 */
export const TERMINAL_ASYNC_JOB_STATES = new Set(['complete', 'completed', 'failed', 'paused', 'stopped']);

/** How long a terminal job stays queryable before eviction. */
const DEFAULT_RETENTION_MS = 10_000;
/** How often tracked jobs' status is refreshed from disk. */
const DEFAULT_POLL_INTERVAL_MS = 250;

const POLL_SUBSCRIBER_ID = 'async-job-tracker';

/**
 * The minimum shape this module reads. A run's actual `status.json` carries
 * far more (this package has no shared status type yet - see
 * `staleRunReconciler.ts`'s `ReconcilableStatus` for the same caveat);
 * everything else is simply not read here.
 */
export interface TrackedAsyncJob {
  runId: string;
  /** Named agent executing this run. Absent until the first readable status. */
  agent?: string;
  /** `status.json`'s `state` field. `undefined` until the first successful read. */
  status: string | undefined;
  startedAt?: number;
  updatedAt?: number;
  error?: string;
  /** `status.json`'s `activityState` field, e.g. `'needs_attention'`. See the module doc. */
  activityState?: ActivityState;
  /** `status.json`'s `reason` field, present alongside `activityState` (e.g. `'missing-deliverable'`). */
  attentionReason?: string;
  /** Which runtime is executing this run. Absent means the default `pi` path. */
  runtime?: string;
  tokens?: number;
  currentTool?: string;
  toolCount?: number;
}

export type TrackedAsyncJobsContract = {
  /**
   * Start tracking `runId`: reads its current status synchronously (so a
   * caller sees something immediately) and adds it to the poll rotation.
   * Calling this again for an id already tracked simply re-reads it now,
   * the same idempotent-refresh idiom as `CoalescedStatusWriter.open()`.
   */
  track(runId: string): void;
  /** Stop tracking `runId` immediately, without waiting out its retention window. */
  untrack(runId: string): void;
  /** Every currently tracked job (in-flight, or terminal within its retention window). */
  list(): TrackedAsyncJob[];
  get(runId: string): TrackedAsyncJob | undefined;
  /** Drop every tracked job. */
  reset(): void;
};

export type AsyncJobTrackerContract = TrackedAsyncJobsContract & {
  /** Return the isolated run collection owned by one Pi session context. */
  forSession(sessionId: string): TrackedAsyncJobsContract;
  /** Register with `PollScheduler`. Call once; a second call is a reset, same as `ResultWatcher.start()`. */
  start(): void;
  /** Unregister from `PollScheduler` and drop every tracked job. */
  stop(): void;
};

/** Resolve an exact id or unique prefix only inside one Pi session's run collection. */
export function resolveTrackedRunId(jobs: TrackedAsyncJobsContract, id: string): string {
  const matches = jobs
    .list()
    .map((job) => job.runId)
    .filter((runId) => runId === id || runId.startsWith(id));
  const exact = matches.find((runId) => runId === id);
  if (exact) return exact;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No current-session run found for '${id}'.`);
  throw new Error(`Multiple current-session runs match '${id}'. Use a longer id.`);
}

interface SessionJobs {
  jobs: Map<string, TrackedAsyncJob>;
  terminalAt: Map<string, number>;
}

const UNSCOPED_SESSION = '__unscoped__';

function statusPathFor(runId: string): string {
  return path.join(currentRunsDir(), runId, STATUS_FILE_NAME);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

interface ReadStatusResult {
  agent: string;
  status: string | undefined;
  startedAt?: number;
  updatedAt?: number;
  error?: string;
  activityState?: ActivityState;
  attentionReason?: string;
  runtime?: string;
  tokens?: number;
  currentTool?: string;
  toolCount?: number;
}

const VALID_ACTIVITY_STATES: ReadonlySet<string> = new Set<ActivityState>([
  'starting',
  'working',
  'tool',
  'waiting_for_reply',
  'needs_attention',
  'finalizing',
  'active_long_running',
]);

function asActivityState(value: unknown): ActivityState | undefined {
  return typeof value === 'string' && VALID_ACTIVITY_STATES.has(value) ? (value as ActivityState) : undefined;
}

export class AsyncJobTracker implements AsyncJobTrackerContract {
  constructor(private readonly scheduler: PollSchedulerContract) {}

  /**
   * Runtime tuning seams for tests, kept out of the dependency constructor.
   */
  protected readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  protected readonly retentionMs: number = DEFAULT_RETENTION_MS;

  protected now(): number {
    return Date.now();
  }

  protected readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  protected async readFileAsync(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private readonly sessions = new Map<string, SessionJobs>();
  private unregisterPoll: (() => void) | undefined;

  private session(sessionId: string): SessionJobs {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { jobs: new Map(), terminalAt: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  forSession(sessionId: string): TrackedAsyncJobsContract {
    if (!sessionId.trim()) throw new Error('Pi session identity is required to track subagent runs.');
    return {
      track: (runId) => this.trackInSession(sessionId, runId),
      untrack: (runId) => this.untrackInSession(sessionId, runId),
      list: () => this.listInSession(sessionId),
      get: (runId) => this.getInSession(sessionId, runId),
      reset: () => this.resetSession(sessionId),
    };
  }

  private parseStatus(runId: string, raw: string | undefined): ReadStatusResult | undefined {
    if (raw === undefined) return undefined;
    const result = parseAsyncRunStatus(raw, statusPathFor(runId));
    if (result.kind !== 'ok') return undefined;
    const status = result.status;
    return {
      agent: status.agent,
      status: status.state,
      startedAt: status.startedAt,
      updatedAt: status.lastUpdate,
      error: status.error,
      activityState: asActivityState(status.activityState),
      attentionReason: status.attentionReason,
      runtime: status.runtime,
      tokens: status.tokens,
      currentTool: status.currentTool,
      toolCount: status.toolCount,
    };
  }

  private readStatus(runId: string): ReadStatusResult | undefined {
    return this.parseStatus(runId, this.readFile(statusPathFor(runId)));
  }

  private async readStatusAsync(runId: string): Promise<ReadStatusResult | undefined> {
    return this.parseStatus(runId, await this.readFileAsync(statusPathFor(runId)));
  }

  private applyStatus(sessionId: string, runId: string, read: ReadStatusResult | undefined): boolean {
    // Teardown (`stop()`, `reset()`) can land between two of the tick's awaits.
    // A late refresh must observe that and drop its result, never recreate the
    // session it belonged to: resurrecting it here is what made `stop()` not stop.
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const existing = session.jobs.get(runId);
    if (read === undefined) {
      // A run may not have created its file yet, and a torn read must not blank
      // a previously known status for one polling pass.
      if (existing) return false;
      session.jobs.set(runId, { runId, status: undefined });
      return false;
    }

    const job: TrackedAsyncJob = { runId, ...read };
    session.jobs.set(runId, job);
    const wasTerminal = existing?.status !== undefined && TERMINAL_ASYNC_JOB_STATES.has(existing.status);
    const isTerminal = job.status !== undefined && TERMINAL_ASYNC_JOB_STATES.has(job.status);
    if (isTerminal && !wasTerminal) session.terminalAt.set(runId, this.now());
    if (!isTerminal) session.terminalAt.delete(runId);
    return (
      !existing ||
      existing.status !== job.status ||
      existing.updatedAt !== job.updatedAt ||
      existing.tokens !== job.tokens ||
      existing.currentTool !== job.currentTool ||
      existing.toolCount !== job.toolCount
    );
  }

  private refresh(sessionId: string, runId: string): boolean {
    return this.applyStatus(sessionId, runId, this.readStatus(runId));
  }

  private async refreshAsync(sessionId: string, runId: string): Promise<boolean> {
    return this.applyStatus(sessionId, runId, await this.readStatusAsync(runId));
  }

  /** One scheduler tick: asynchronously refresh every tracked status, then evict expired terminal jobs. */
  protected async run(): Promise<boolean> {
    let changed = false;
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      for (const runId of session.jobs.keys()) {
        if (await this.refreshAsync(sessionId, runId)) changed = true;
      }
      for (const [runId, terminatedAt] of session.terminalAt) {
        if (now - terminatedAt <= this.retentionMs) continue;
        session.jobs.delete(runId);
        session.terminalAt.delete(runId);
        changed = true;
      }
      // Only drop the entry this pass actually walked: a `track()` that landed
      // during an await above may have installed a fresh one under the same id.
      if (session.jobs.size === 0 && this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    }

    return changed;
  }

  track(runId: string): void {
    this.trackInSession(UNSCOPED_SESSION, runId);
  }

  untrack(runId: string): void {
    this.untrackInSession(UNSCOPED_SESSION, runId);
  }

  list(): TrackedAsyncJob[] {
    return this.listInSession(UNSCOPED_SESSION);
  }

  get(runId: string): TrackedAsyncJob | undefined {
    return this.getInSession(UNSCOPED_SESSION, runId);
  }

  reset(): void {
    this.resetSession(UNSCOPED_SESSION);
  }

  private trackInSession(sessionId: string, runId: string): void {
    // `applyStatus` no longer creates sessions (see its comment), so tracking is
    // the one path that does.
    this.session(sessionId);
    this.refresh(sessionId, runId);
  }

  private untrackInSession(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    session?.jobs.delete(runId);
    session?.terminalAt.delete(runId);
    if (session?.jobs.size === 0) this.sessions.delete(sessionId);
  }

  private listInSession(sessionId: string): TrackedAsyncJob[] {
    return [...(this.sessions.get(sessionId)?.jobs.values() ?? [])];
  }

  private getInSession(sessionId: string, runId: string): TrackedAsyncJob | undefined {
    return this.sessions.get(sessionId)?.jobs.get(runId);
  }

  private resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  start(): void {
    this.stop();
    this.unregisterPoll = this.scheduler.register({
      id: POLL_SUBSCRIBER_ID,
      intervalMs: this.pollIntervalMs,
      run: () => this.run(),
    });
  }

  stop(): void {
    this.unregisterPoll?.();
    this.unregisterPoll = undefined;
    this.sessions.clear();
  }
}
