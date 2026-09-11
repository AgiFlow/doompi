import type { SessionScope } from './filesystem/paths';
import type { ActivityState } from '../types';
import type { ExternalRunProjection } from './process/externalProcessIpc';

export const TERMINAL_ASYNC_JOB_STATES = new Set(['complete', 'completed', 'failed', 'paused', 'stopped']);
const DEFAULT_RETENTION_MS = 10_000;

type ExternalResult = Record<string, unknown>;

export interface TrackedAsyncJob {
  runId: string;
  agent?: string;
  status: string | undefined;
  startedAt?: number;
  updatedAt?: number;
  error?: string;
  activityState?: ActivityState;
  attentionReason?: string;
  runtime?: string;
  task?: string;
  cwd?: string;
  sessionFile?: string;
  transcriptPath?: string;
  summary?: string;
  native?: boolean;
  tokens?: number;
  cost?: number;
  currentTool?: string;
  toolCount?: number;
}

export interface NativeAsyncJobProjection {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  runtime: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  sessionFile?: string;
  transcriptPath?: string;
  summary?: string;
}

export type TrackedAsyncJobsContract = {
  track(runId: string): void;
  untrack(runId: string): void;
  list(): TrackedAsyncJob[];
  get(runId: string): TrackedAsyncJob | undefined;
  reset(): void;
};

export type AsyncJobTrackerContract = {
  forSession(sessionId: string, scope: SessionScope): TrackedAsyncJobsContract;
  stop(): void;
};

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
  scope: SessionScope;
  jobs: Map<string, TrackedAsyncJob>;
  terminalAt: Map<string, number>;
  handedOff: Set<string>;
  cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
}

function isTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_ASYNC_JOB_STATES.has(status);
}

function changed(previous: TrackedAsyncJob | undefined, next: TrackedAsyncJob): boolean {
  if (!previous) return true;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

const ACTIVITY_STATES: ReadonlySet<string> = new Set([
  'starting',
  'working',
  'tool',
  'waiting_for_reply',
  'needs_attention',
  'finalizing',
  'active_long_running',
]);

function activityState(value: string | undefined): ActivityState | undefined {
  return value !== undefined && ACTIVITY_STATES.has(value) ? (value as ActivityState) : undefined;
}

export class AsyncJobTracker implements AsyncJobTrackerContract {
  protected readonly retentionMs = DEFAULT_RETENTION_MS;
  private readonly sessions = new Map<string, SessionJobs>();
  private readonly listeners = new Map<string, Set<() => void>>();

  private session(sessionId: string, scope: SessionScope): SessionJobs {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.scope.scopeKey !== scope.scopeKey)
        throw new Error(`Session '${sessionId}' is already bound to another scope.`);
      return existing;
    }
    const created: SessionJobs = {
      scope,
      jobs: new Map(),
      terminalAt: new Map(),
      handedOff: new Set(),
      cleanupTimers: new Map(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private invalidate(sessionId: string): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener();
  }

  forSession(sessionId: string, scope: SessionScope): TrackedAsyncJobsContract {
    if (!sessionId.trim()) throw new Error('Pi session identity is required to track subagent runs.');
    this.session(sessionId, scope);
    return {
      track: (runId) => this.trackInSession(sessionId, runId),
      untrack: (runId) => this.untrackInSession(sessionId, runId),
      list: () => this.listInSession(sessionId),
      get: (runId) => this.getInSession(sessionId, runId),
      reset: () => this.resetSession(sessionId),
    };
  }

  upsertNative(sessionId: string, scope: SessionScope, projection: NativeAsyncJobProjection): void {
    const session = this.session(sessionId, scope);
    const previous = session.jobs.get(projection.runId);
    const next: TrackedAsyncJob = { ...projection, native: true };
    this.install(sessionId, session, next, previous);
  }

  getNative(sessionId: string, runId: string): NativeAsyncJobProjection | undefined {
    const job = this.sessions.get(sessionId)?.jobs.get(runId);
    return job?.native ? (job as NativeAsyncJobProjection) : undefined;
  }

  upsertExternal(sessionId: string, scope: SessionScope, projection: ExternalRunProjection): void {
    const session = this.session(sessionId, scope);
    const previous = session.jobs.get(projection.runId);
    const next: TrackedAsyncJob = {
      runId: projection.runId,
      agent: projection.agent,
      task: projection.task,
      cwd: projection.cwd,
      runtime: projection.runtime,
      status: projection.state,
      startedAt: projection.startedAt,
      updatedAt: projection.updatedAt,
      ...(projection.error === undefined ? {} : { error: projection.error }),
      ...(projection.summary === undefined ? {} : { summary: projection.summary }),
      ...(projection.tokens === undefined ? {} : { tokens: projection.tokens }),
      ...(projection.cost === undefined ? {} : { cost: projection.cost }),
      ...(projection.currentTool === undefined ? {} : { currentTool: projection.currentTool }),
      ...(projection.toolCount === undefined ? {} : { toolCount: projection.toolCount }),
      ...(activityState(projection.activityState) === undefined
        ? {}
        : { activityState: activityState(projection.activityState) }),
      ...(projection.attentionReason === undefined ? {} : { attentionReason: projection.attentionReason }),
      ...(projection.sessionFile === undefined ? {} : { sessionFile: projection.sessionFile }),
      ...(projection.transcriptPath === undefined ? {} : { transcriptPath: projection.transcriptPath }),
    };
    this.install(sessionId, session, next, previous);
  }

  markExternalFailed(sessionId: string, scope: SessionScope, runId: string, error: string): void {
    const session = this.session(sessionId, scope);
    const previous = session.jobs.get(runId);
    const now = Date.now();
    const next: TrackedAsyncJob = {
      ...(previous ?? { runId }),
      runId,
      status: 'failed',
      error,
      updatedAt: now,
    };
    this.install(sessionId, session, next, previous);
  }

  acceptExternalResult(sessionId: string, scope: SessionScope, runId: string, result: ExternalResult): boolean {
    const session = this.session(sessionId, scope);
    const previous = session.jobs.get(runId);
    if (!previous) return false;
    const success = result.success;
    const state = typeof result.state === 'string' ? result.state : success === false ? 'failed' : 'completed';
    const summary = typeof result.summary === 'string' ? result.summary : previous.summary;
    const next: TrackedAsyncJob = {
      ...previous,
      status: state,
      updatedAt: typeof result.updatedAt === 'number' ? result.updatedAt : Date.now(),
      ...(summary === undefined ? {} : { summary }),
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
    };
    this.install(sessionId, session, next, previous);
    return true;
  }

  private install(
    sessionId: string,
    session: SessionJobs,
    next: TrackedAsyncJob,
    previous: TrackedAsyncJob | undefined,
  ): void {
    session.jobs.set(next.runId, next);
    const terminal = isTerminal(next.status);
    if (terminal && !isTerminal(previous?.status)) session.terminalAt.set(next.runId, Date.now());
    if (!terminal) {
      session.terminalAt.delete(next.runId);
      session.handedOff.delete(next.runId);
      this.clearCleanupTimer(session, next.runId);
    }
    if (changed(previous, next)) this.invalidate(sessionId);
  }

  acknowledgeHandoff(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    const status = session?.jobs.get(runId)?.status;
    if (!session || !isTerminal(status) || session.handedOff.has(runId)) return;
    session.handedOff.add(runId);
    this.invalidate(sessionId);
    const timer = setTimeout(() => {
      this.removeIfRetained(sessionId, runId);
    }, this.retentionMs);
    timer.unref?.();
    session.cleanupTimers.set(runId, timer);
  }

  listBackgroundWork(sessionId: string): TrackedAsyncJob[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return [...session.jobs.values()].filter((job) => !isTerminal(job.status) || !session.handedOff.has(job.runId));
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    if (!sessionId.trim()) throw new Error('Pi session identity is required to subscribe to subagent runs.');
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  private trackInSession(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' must be bound to an explicit scope before tracking runs.`);
    if (!session.jobs.has(runId)) {
      session.jobs.set(runId, { runId, status: undefined });
      this.invalidate(sessionId);
    }
  }

  private untrackInSession(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clearCleanupTimer(session, runId);
    const deleted = session.jobs.delete(runId);
    session.terminalAt.delete(runId);
    session.handedOff.delete(runId);
    if (session.jobs.size === 0) this.sessions.delete(sessionId);
    if (deleted) this.invalidate(sessionId);
  }

  private removeIfRetained(sessionId: string, runId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.handedOff.has(runId)) return;
    session.cleanupTimers.delete(runId);
    this.untrackInSession(sessionId, runId);
  }

  private clearCleanupTimer(session: SessionJobs, runId: string): void {
    const timer = session.cleanupTimers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      session.cleanupTimers.delete(runId);
    }
  }

  private resetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const timer of session.cleanupTimers.values()) clearTimeout(timer);
    const hadJobs = session.jobs.size > 0;
    this.sessions.delete(sessionId);
    if (hadJobs) this.invalidate(sessionId);
  }

  private listInSession(sessionId: string): TrackedAsyncJob[] {
    return [...(this.sessions.get(sessionId)?.jobs.values() ?? [])];
  }

  private getInSession(sessionId: string, runId: string): TrackedAsyncJob | undefined {
    return this.sessions.get(sessionId)?.jobs.get(runId);
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      for (const timer of session.cleanupTimers.values()) clearTimeout(timer);
    }
    this.sessions.clear();
    this.listeners.clear();
  }
}
