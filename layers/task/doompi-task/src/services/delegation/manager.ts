import {
  type DelegationAccepted as DelegationAcceptedPayload,
  DOOM_DELEGATION_ACCEPTED_EVENT,
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_STARTED_EVENT,
  DOOM_DELEGATION_UPDATED_EVENT,
  type DoomDelegationService,
  type DelegationResult,
  type DelegationStarted as DelegationStartedPayload,
  type DelegationUpdate,
} from '@agimon-ai/doompi-extension-contracts/delegation';
import type { InlineAgent } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import type { Context } from '@deepseek-ai/cordis';
import { TASK_EVENT, type TaskEventName, type TaskFailureReporter } from '../../types/telemetry.ts';
import { reconcileOrphanedDelegations } from '../store/reconcile.ts';
import { isBlocked, isTaskListComplete } from '../store/taskGraph.ts';
import type { TaskStore } from '../../adapters/store/taskStore';
import { MAX_BRIEF_FILES } from '../../types/delegation';

export { MAX_BRIEF_FILES };
import { isDelegationActive, type Task, type TaskDelegation, type TaskDocument } from '../store/types.ts';

export const NOTIFY_CUSTOM_TYPE = 'doom-task-notify';
export const BACKGROUND_WORK_PROVIDER = 'doom-task';

const DEFAULT_STARTED_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;
const MAX_RUN_TIMEOUT_GRACE_MS = 60_000;
const MAX_STORED_OUTPUT = 4000;
/**
 * Cap on files rendered into a brief. Exported so the tool schema can state the
 * same number to the model rather than restating it and drifting.
 */
const MAX_BRIEF_NOTES = 1500;
const COMPLETED_STATE = 'completed';
const FAILED_STATE = 'failed';
const CANCELLED_STATE = 'cancelled';
const TIMED_OUT_STATUS = 'timed_out';
const DELETED_STATUS: Task['status'] = 'deleted';

const TASK_ID_ATTRIBUTE = 'task.id';
const REQUEST_ID_ATTRIBUTE = 'delegation.request_id';
// `_name` suffix is load-bearing: the telemetry redactor drops string values
// whose key has no safe meaning, and a bare `delegation.agent` is dropped.
const AGENT_ATTRIBUTE = 'delegation.agent_name';
const PID_ATTRIBUTE = 'delegation.pid';
const CONTEXT_PRESENT_ATTRIBUTE = 'delegation.context_present';
const CONTEXT_FILE_COUNT_ATTRIBUTE = 'delegation.context_file_count';
const CONTEXT_NOTES_LENGTH_ATTRIBUTE = 'delegation.context_notes_length';
const BRIEF_LENGTH_ATTRIBUTE = 'delegation.brief_length';
const TOOL_COUNT_ATTRIBUTE = 'delegation.tool_count';
const DURATION_MS_ATTRIBUTE = 'delegation.duration_ms';
const OUTCOME_ATTRIBUTE = 'delegation.outcome';

type SettlementState = typeof COMPLETED_STATE | typeof FAILED_STATE | typeof CANCELLED_STATE;

export const ERR_NO_RUNTIME =
  'No subagent runtime responded. Delegation needs the subagents extension — relaunch doom-pi with agents enabled.';
export const ERR_CHILD_SESSION =
  'assign is only available in the main session. Update this task directly instead of re-delegating it.';
export const ERR_CANCEL_UNACKNOWLEDGED = 'Subagent did not acknowledge the cancel request';

/** Live progress from a running subagent. Kept in memory: persisting per-tool
 * ticks would rewrite the store file every second for no durable benefit. */
export interface DelegationProgress {
  agent: string;
  currentTool?: string;
  toolCount?: number;
  tokens?: number;
  /** Latest child-runtime duration baseline, excluding assignment wait. */
  durationMs?: number;
  /** Wall-clock time at which durationMs was observed or rebased. */
  durationObservedAt?: number;
  /** Assign-time context-pack shape, carried so the completion event can be
   * grouped by it without joining back to the assignment event. */
  contextFileCount?: number;
  contextNotesLength?: number;
}

export type DelegationNotifier = (
  message: { customType: string; content: string; display: boolean },
  options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
) => void;

export interface DelegationPlatform {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly processId: number;
  readonly createRequestId: () => string;
  readonly formatBriefPath: (entry: string, cwd: string) => string;
}

export interface DelegationManagerOptions {
  store: TaskStore;
  cwd: string;
  platform: DelegationPlatform;
  notify?: DelegationNotifier;
  getSessionId?: () => string | undefined;
  onChange?: () => void;
  startedTimeoutMs?: number;
  /** How long a started run may go without reporting a result. */
  runTimeoutMs?: number;
  /** How long to wait for a cancelled run to report back before forcing it. */
  cancelTimeoutMs?: number;
  now?: () => string;
  nowMs?: () => number;
  /** Called when a completion notification could not be delivered. */
  onNotifyError: (error: unknown, taskId: number) => void;
  /** Where other swallowed delegation failures go. */
  report?: TaskFailureReporter;
}

export interface AssignOptions {
  agent?: string;
  inlineAgent?: InlineAgent;
  instructions?: string;
  /** Paths the parent already located, rendered into the brief so the child
   * skips rediscovering them. */
  relevantFiles?: string[];
  /** Facts the parent already established, rendered into the brief so the child
   * does not re-derive them. */
  priorFindings?: string;
  model?: string;
  context?: 'fresh' | 'fork';
  signal?: AbortSignal;
}

export interface DelegationOutcome {
  ok: boolean;
  message: string;
}

/** Result of the guarded store mutation that claims a task for delegation. */
interface AssignAttempt extends DelegationOutcome {
  task?: Task;
}

interface PendingTask {
  readonly taskId: number;
  readonly sessionId?: string;
}

function truncate(value: string | undefined, limit = MAX_STORED_OUTPUT): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (truncated)`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The assign-time context pack, normalized once for the brief and the telemetry. */
interface BriefContext {
  files: string[];
  notes?: string;
}

/** Normalize the parent context with host-owned path semantics. */
function briefContext(options: AssignOptions, cwd: string, platform: DelegationPlatform): BriefContext {
  const files = new Set<string>();
  for (const entry of options.relevantFiles ?? []) {
    if (files.size >= MAX_BRIEF_FILES) break;
    const normalized = platform.formatBriefPath(entry.trim(), cwd);
    if (normalized && normalized !== '.') files.add(normalized);
  }
  return { files: [...files], notes: truncate(options.priorFindings?.trim(), MAX_BRIEF_NOTES) };
}

/**
 * Build the brief handed to the subagent.
 *
 * Doom Team owns the child tool surface and the parent owns the task record.
 * Keeping those responsibilities explicit prevents a child from attempting to
 * call a task tool that is not loaded in its runtime, while still giving it a
 * reliable path to ask the parent for a decision.
 *
 * The context pack is the parent's verified discovery handed over. The whole
 * block is omitted when nothing was supplied: this brief is the child's whole
 * starting context, so an empty section header is pure token cost.
 */
function buildBrief(task: Task, instructions: string | undefined, context: BriefContext): string {
  const sections = [`Task #${task.id}: ${task.subject}`];
  if (task.description) sections.push(task.description);
  if (instructions) sections.push(instructions);
  if (context.files.length > 0 || context.notes) {
    const contextLines = ['Parent context — consume before repository discovery:'];
    if (context.files.length > 0) {
      contextLines.push(`- Parent-verified files (read these first with direct reads): ${context.files.join(', ')}`);
    }
    if (context.notes) {
      contextLines.push(
        `- Established facts (do not re-derive unless direct evidence contradicts them): ${context.notes}`,
      );
    }
    contextLines.push(
      'This pack satisfies initial repository/context exploration. Do not begin with repository-wide listing, find, or grep. Expand only after consuming the pack and naming a concrete missing dependency or invalid path; search narrowly for that item and state why.',
    );
    sections.push(contextLines.join('\n'));
  }
  sections.push(
    'Coordination: work directly without changing the task record; ask main through intercom only for blockers or decisions; report changed files and verification when done.',
  );
  return sections.join('\n\n');
}

/**
 * Owns the lifecycle of tasks delegated to subagents.
 *
 * Delegation rides Team's injected Cordis service rather than spawning
 * processes directly, so doom-task stays decoupled from the subagent runtime
 * and degrades to a clear error when that service is not loaded.
 *
 * Liveness rule: every entry in `pendingTasks` has a timer armed against it, so
 * a delegation always has a deadline no matter which phase it is in. Losing
 * that pairing is what previously left tasks running forever.
 */
export class DelegationManager {
  private readonly options: DelegationManagerOptions;
  private readonly progress = new Map<string, DelegationProgress>();
  private readonly pendingTasks = new Map<string, PendingTask>();
  private readonly settlingRequests = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: Array<() => void> = [];
  private service: DoomDelegationService | undefined;

  constructor(options: DelegationManagerOptions) {
    this.options = options;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private get runTimeoutMs(): number {
    return this.options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  private report(event: TaskEventName, error: unknown, attributes?: Record<string, string | number | boolean>): void {
    this.options.report?.error(event, error, attributes);
  }

  /** True in a session that is itself a subagent child. */
  get isChildSession(): boolean {
    return Boolean(this.options.platform.environment.PI_SUBAGENT_CHILD);
  }

  /** Live progress for a task, for the overlay to render. */
  progressFor(task: Task): DelegationProgress | undefined {
    const requestId = task.delegation?.requestId;
    return requestId ? this.progress.get(requestId) : undefined;
  }

  /** Displayed runtime duration, rebased from the latest child observation. */
  static elapsedMs(progress: DelegationProgress, nowMs = Date.now()): number {
    const baseline = progress.durationMs ?? 0;
    const observedAt = progress.durationObservedAt ?? nowMs;
    return baseline + Math.max(0, nowMs - observedAt);
  }

  /** Rebind to the active Team service without stacking lifecycle listeners. */
  bind(ctx: Context, service: DoomDelegationService): () => void {
    this.unbind();
    this.service = service;
    this.subscriptions.push(
      ctx.on(DOOM_DELEGATION_ACCEPTED_EVENT, (event) => {
        this.handleAccepted(event);
      }),
      ctx.on(DOOM_DELEGATION_STARTED_EVENT, (event) => {
        this.handleStarted(event);
      }),
      ctx.on(DOOM_DELEGATION_UPDATED_EVENT, (event) => {
        this.handleUpdate(event);
      }),
      ctx.on(DOOM_DELEGATION_FINISHED_EVENT, (event) => {
        void this.handleResponse(event).catch((error: unknown) => {
          this.report(TASK_EVENT.delegationResponseFailed, error, { [REQUEST_ID_ATTRIBUTE]: event.requestId });
        });
      }),
    );
    return () => {
      if (this.service === service) this.unbind();
    };
  }

  /** Remove only the cross-package binding; task state and watchdogs remain live. */
  unbind(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.service = undefined;
  }

  /** Items still in flight, surfaced so auto-stop will not kill the harness. */
  listActiveWork(): Array<{ id: string; sessionId: string }> {
    return [...this.pendingTasks.entries()].flatMap(([requestId, pending]) =>
      pending.sessionId ? [{ id: `task-${pending.taskId}:${requestId}`, sessionId: pending.sessionId }] : [],
    );
  }

  /**
   * Return tasks nothing can finish to `pending`.
   *
   * The live request set is read inside the mutation so a delegation assigned
   * while the lock was contended is not mistaken for a leftover.
   */
  async reconcile(isCurrent: () => boolean = () => true): Promise<Task[]> {
    const { value } = await this.options.store.mutate((document) => {
      if (!isCurrent()) return { value: [] as Task[] };
      const result = reconcileOrphanedDelegations(document, this.now(), undefined, {
        pid: this.options.platform.processId,
        liveRequestIds: new Set(this.pendingTasks.keys()),
      });
      if (result.orphaned.length === 0) return { value: [] as Task[] };
      return { document: result.document, value: result.orphaned };
    });

    if (!isCurrent()) return [];
    for (const task of value) {
      this.options.report?.warn(TASK_EVENT.delegationOrphaned, new Error(task.delegation?.result?.error ?? ''), {
        [TASK_ID_ATTRIBUTE]: task.id,
        ...(task.delegation?.agent ? { [AGENT_ATTRIBUTE]: task.delegation.agent } : {}),
        ...(task.delegation?.pid === undefined ? {} : { [PID_ATTRIBUTE]: task.delegation.pid }),
      });
    }

    if (value.length > 0) this.options.onChange?.();
    return value;
  }

  async assign(taskId: number, options: AssignOptions): Promise<DelegationOutcome> {
    const agent = options.agent?.trim();
    if (!agent) return { ok: false, message: 'agent required for assign' };
    if (this.isChildSession) return { ok: false, message: ERR_CHILD_SESSION };
    if (options.signal?.aborted) return { ok: false, message: 'delegation cancelled before it started' };

    const requestId = this.options.platform.createRequestId();
    const startedAt = this.now();
    const sessionId = this.options.getSessionId?.();
    const context = briefContext(options, this.options.cwd, this.options.platform);

    const { value: outcome } = await this.options.store.mutate<AssignAttempt>((current) => {
      const index = current.tasks.findIndex((task) => task.id === taskId);
      if (index === -1) return { value: { ok: false, message: `#${taskId} not found` } };

      const task = current.tasks[index];
      if (task.status === DELETED_STATUS) return { value: { ok: false, message: `#${taskId} is deleted` } };
      if (task.status === COMPLETED_STATE) {
        return { value: { ok: false, message: `#${taskId} is already completed` } };
      }
      if (isDelegationActive(task)) {
        return { value: { ok: false, message: `#${taskId} is already delegated to ${task.delegation?.agent}` } };
      }
      if (isBlocked(current.tasks, task)) {
        const blockers = (task.blockedBy ?? []).map((id) => `#${id}`).join(', ');
        return { value: { ok: false, message: `#${taskId} is blocked by ${blockers}` } };
      }

      const delegation: TaskDelegation = {
        requestId,
        agent,
        state: 'requested',
        pid: this.options.platform.processId,
        startedAt,
        ...(sessionId ? { sessionId } : {}),
        ...(options.model ? { model: options.model } : {}),
      };

      const tasks = [...current.tasks];
      tasks[index] = { ...task, owner: agent, updatedAt: startedAt, delegation };
      return {
        document: { ...current, tasks },
        value: { ok: true, message: '', task: tasks[index] },
      };
    });

    if (!outcome.ok || !outcome.task) return { ok: false, message: outcome.message };

    const contextNotesLength = context.notes?.length ?? 0;
    this.pendingTasks.set(requestId, { taskId, sessionId });
    this.progress.set(requestId, { agent, contextFileCount: context.files.length, contextNotesLength });
    this.armStartedTimeout(requestId);
    this.options.onChange?.();
    const request = {
      requestId,
      taskId,
      agent,
      ...(options.inlineAgent ? { inlineAgent: options.inlineAgent } : {}),
      prompt: buildBrief(outcome.task, options.instructions, context),
      ...(options.context ? { context: options.context } : {}),
      cwd: this.options.cwd,
      artifacts: true,
      timeoutMs: this.runTimeoutMs,
      runMode: 'detached' as const,
      teamTask: { id: String(outcome.task.id), subject: outcome.task.subject },
      ...(options.model ? { model: options.model } : {}),
    };

    try {
      const service = this.service;
      if (!service) throw new Error(ERR_NO_RUNTIME);
      void service.request(request).catch((error: unknown) => {
        this.report(TASK_EVENT.delegationRequestFailed, error, {
          [TASK_ID_ATTRIBUTE]: taskId,
          [REQUEST_ID_ATTRIBUTE]: requestId,
          [AGENT_ATTRIBUTE]: agent,
        });
        this.settleDetached(requestId, FAILED_STATE, {
          status: FAILED_STATE,
          error: `Delegation request failed: ${messageOf(error)}`,
        });
      });
    } catch (error) {
      this.report(TASK_EVENT.delegationRequestFailed, error, {
        [TASK_ID_ATTRIBUTE]: taskId,
        [REQUEST_ID_ATTRIBUTE]: requestId,
        [AGENT_ATTRIBUTE]: agent,
      });
      const detail = messageOf(error);
      await this.settle(requestId, FAILED_STATE, {
        status: FAILED_STATE,
        error: `Delegation request failed: ${detail}`,
      });
      return { ok: false, message: `Could not dispatch #${taskId} to ${agent}: ${detail}` };
    }

    // Recorded only after the service accepted the request call, so it means a
    // brief actually entered Team's state machine rather than merely being assembled.
    this.options.report?.event(TASK_EVENT.delegationAssigned, {
      [TASK_ID_ATTRIBUTE]: taskId,
      [REQUEST_ID_ATTRIBUTE]: requestId,
      [AGENT_ATTRIBUTE]: agent,
      [CONTEXT_PRESENT_ATTRIBUTE]: context.files.length > 0 || contextNotesLength > 0,
      [CONTEXT_FILE_COUNT_ATTRIBUTE]: context.files.length,
      [CONTEXT_NOTES_LENGTH_ATTRIBUTE]: contextNotesLength,
      [BRIEF_LENGTH_ATTRIBUTE]: request.prompt.length,
    });

    return {
      ok: true,
      message: `Delegated #${taskId} to ${agent} in the background. It runs independently of this turn and will notify you when it finishes. Continue non-overlapping work, or end your turn.`,
    };
  }

  async cancel(taskId: number): Promise<DelegationOutcome> {
    const document = this.options.store.read();
    const task = document.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return { ok: false, message: `#${taskId} not found` };
    if (!task.delegation || !isDelegationActive(task)) {
      return { ok: false, message: `#${taskId} has no running delegation` };
    }

    const { requestId } = task.delegation;
    this.service?.cancel({ requestId });
    // Only this session can force the outcome; a delegation owned elsewhere
    // gets the request and nothing more.
    this.armCancelTimeout(requestId);
    return { ok: true, message: `Cancelling delegation for #${taskId} (${task.delegation.agent})` };
  }

  /** Settle without awaiting, reporting rather than dropping a failure. */
  private settleDetached(
    requestId: string,
    state: SettlementState,
    result: TaskDelegation['result'],
    event: TaskEventName = TASK_EVENT.delegationSettleFailed,
  ): void {
    void this.settle(requestId, state, result).catch((error: unknown) => {
      this.report(event, error, { [REQUEST_ID_ATTRIBUTE]: requestId });
    });
  }

  /**
   * Fail a delegation that nobody acknowledged.
   *
   * Provider loss or a stalled Team runtime can still leave a dispatched
   * request silent. Without this acknowledgement deadline the task would sit
   * in `requested` forever.
   */
  private armStartedTimeout(requestId: string): void {
    this.armTimer(requestId, this.options.startedTimeoutMs ?? DEFAULT_STARTED_TIMEOUT_MS, () => {
      this.settleDetached(requestId, FAILED_STATE, { status: FAILED_STATE, error: ERR_NO_RUNTIME });
    });
  }

  /**
   * Bound a run that already started.
   *
   * The request carries the same budget, so in the normal case the runtime ends
   * the run itself and reports a richer result. The grace period biases toward
   * that answer; this timer only covers a runtime that goes silent, which is
   * precisely the case where no response event will ever arrive.
   */
  private armRunTimeout(requestId: string): void {
    const grace = Math.min(MAX_RUN_TIMEOUT_GRACE_MS, this.runTimeoutMs);
    this.armTimer(requestId, this.runTimeoutMs + grace, () => {
      const taskId = this.pendingTasks.get(requestId)?.taskId;
      const agent = this.progress.get(requestId)?.agent;
      const error = new Error(`Delegation produced no result within ${this.runTimeoutMs}ms`);
      this.options.report?.warn(TASK_EVENT.delegationTimedOut, error, {
        ...(taskId === undefined ? {} : { [TASK_ID_ATTRIBUTE]: taskId }),
        [REQUEST_ID_ATTRIBUTE]: requestId,
        ...(agent ? { [AGENT_ATTRIBUTE]: agent } : {}),
      });
      this.service?.cancel({ requestId, reason: error.message });
      this.settleDetached(requestId, FAILED_STATE, { status: TIMED_OUT_STATUS, error: error.message });
    });
  }

  /**
   * Guarantee a cancel reaches a terminal state.
   *
   * Calling the service is a request, not an outcome: a runtime that has
   * already forgotten the request answers nothing at all. The window still
   * favours a real response, which carries the run's partial output.
   */
  private armCancelTimeout(requestId: string): void {
    if (!this.pendingTasks.has(requestId)) return;
    this.armTimer(requestId, this.options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS, () => {
      this.settleDetached(requestId, CANCELLED_STATE, {
        status: CANCELLED_STATE,
        error: ERR_CANCEL_UNACKNOWLEDGED,
      });
    });
  }

  private armTimer(requestId: string, delayMs: number, onFire: () => void): void {
    this.clearTimer(requestId);
    const timer = setTimeout(onFire, delayMs);
    timer.unref?.();
    this.timers.set(requestId, timer);
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
  }

  /** Runtime acknowledgement moves the request off the short extension-presence watchdog while launch is in flight. */
  private handleAccepted(event: DelegationAcceptedPayload): void {
    if (!this.pendingTasks.has(event.requestId)) return;
    this.armRunTimeout(event.requestId);
  }

  private handleStarted(event: DelegationStartedPayload): void {
    const { runId } = event;
    const taskId = this.pendingTasks.get(event.requestId)?.taskId;
    if (taskId === undefined) return;
    this.armRunTimeout(event.requestId);
    const existing = this.progress.get(event.requestId);
    if (existing) {
      this.progress.set(event.requestId, {
        ...existing,
        durationMs: existing.durationMs ?? 0,
        durationObservedAt: existing.durationObservedAt ?? this.nowMs(),
      });
    }

    void this.options.store
      .mutate((document) =>
        this.patchDelegation(document, event.requestId, (task, delegation) => ({
          ...task,
          status: task.status === COMPLETED_STATE ? task.status : 'in_progress',
          delegation: {
            ...delegation,
            state: 'running',
            startedAt: delegation.startedAt ?? this.now(),
            ...(runId ? { runId } : {}),
          },
        })),
      )
      .then(() => this.options.onChange?.())
      .catch((error: unknown) => {
        this.report(TASK_EVENT.delegationStartFailed, error, {
          [TASK_ID_ATTRIBUTE]: taskId,
          [REQUEST_ID_ATTRIBUTE]: event.requestId,
        });
      });
  }

  private handleUpdate(event: DelegationUpdate): void {
    const existing = this.progress.get(event.requestId);
    if (!existing) return;

    const observedAt = this.nowMs();
    const currentElapsed = DelegationManager.elapsedMs(existing, observedAt);
    const hasDuration = event.durationMs !== undefined;
    this.progress.set(event.requestId, {
      // Spread, not field-by-field: anything carried on progress that this
      // event does not report (the assign-time context shape) must survive the
      // first update, or the completion event reports it as absent.
      ...existing,
      currentTool: event.currentTool ?? existing.currentTool,
      toolCount:
        event.toolCount === undefined ? existing.toolCount : Math.max(existing.toolCount ?? 0, event.toolCount),
      tokens: event.tokens === undefined ? existing.tokens : Math.max(existing.tokens ?? 0, event.tokens),
      durationMs: hasDuration ? Math.max(currentElapsed, event.durationMs!) : existing.durationMs,
      durationObservedAt: hasDuration ? observedAt : existing.durationObservedAt,
    });
    this.options.onChange?.();
  }

  private async handleResponse(event: DelegationResult): Promise<void> {
    if (!this.pendingTasks.has(event.requestId)) return;

    const succeeded = event.status === COMPLETED_STATE && !event.error;
    const state = succeeded ? COMPLETED_STATE : event.status === CANCELLED_STATE ? CANCELLED_STATE : FAILED_STATE;
    await this.settle(event.requestId, state, {
      status: event.status,
      error: event.error,
      output: truncate(event.output),
      outputPath: event.outputPath,
      sessionFile: event.sessionFile,
      durationMs: event.durationMs,
      toolCount: event.toolCount,
    });
  }

  /**
   * Apply the terminal state of a delegation and tell the model about it.
   *
   * A cancelled run returns the task to `pending` (the work is still wanted,
   * just not by that agent); a failure marks it `failed` so it stays visible
   * rather than silently rejoining the backlog.
   *
   * The request is claimed in `settlingRequests` while it remains published as
   * active work. It is removed only after the terminal state and model notification
   * have been handed off, so an auto-stop observer cannot end the session between
   * receiving the result and delivering it to the model.
   */
  private async settle(requestId: string, state: SettlementState, result: TaskDelegation['result']): Promise<void> {
    const pending = this.pendingTasks.get(requestId);
    if (!pending || this.settlingRequests.has(requestId)) return;
    this.settlingRequests.add(requestId);
    this.clearTimer(requestId);
    const { taskId } = pending;
    const progress = this.progress.get(requestId);

    try {
      const endedAt = this.now();
      let task: Task | undefined;
      try {
        const { value } = await this.options.store.mutate((document) =>
          this.patchDelegation(document, requestId, (current, delegation) => ({
            ...current,
            status: state === COMPLETED_STATE ? COMPLETED_STATE : state === CANCELLED_STATE ? 'pending' : FAILED_STATE,
            updatedAt: endedAt,
            delegation: { ...delegation, state, endedAt, ...(result ? { result } : {}) },
          })),
        );
        task = value;
      } catch (error) {
        this.report(TASK_EVENT.delegationSettleFailed, error, {
          [TASK_ID_ATTRIBUTE]: taskId,
          [REQUEST_ID_ATTRIBUTE]: requestId,
        });
      }

      const agent = task?.delegation?.agent ?? progress?.agent ?? 'subagent';
      const subject = task?.subject ?? `#${taskId}`;

      // Repeats the assign-time context shape so the cost question ("did packs
      // reduce child tool calls?") is one grouping rather than a self-join.
      // A run that never started reports neither metric, keeping the medians clean.
      this.options.report?.event(TASK_EVENT.delegationCompleted, {
        [TASK_ID_ATTRIBUTE]: taskId,
        [REQUEST_ID_ATTRIBUTE]: requestId,
        [AGENT_ATTRIBUTE]: agent,
        [OUTCOME_ATTRIBUTE]: state,
        [CONTEXT_PRESENT_ATTRIBUTE]: (progress?.contextFileCount ?? 0) > 0 || (progress?.contextNotesLength ?? 0) > 0,
        [CONTEXT_FILE_COUNT_ATTRIBUTE]: progress?.contextFileCount ?? 0,
        [CONTEXT_NOTES_LENGTH_ATTRIBUTE]: progress?.contextNotesLength ?? 0,
        ...(result?.toolCount === undefined ? {} : { [TOOL_COUNT_ATTRIBUTE]: result.toolCount }),
        ...(result?.durationMs === undefined ? {} : { [DURATION_MS_ATTRIBUTE]: result.durationMs }),
      });
      const listComplete =
        state === COMPLETED_STATE && task !== undefined && isTaskListComplete(this.options.store.snapshot.tasks);
      this.notifyModel(state, taskId, subject, agent, result, listComplete);
    } finally {
      this.pendingTasks.delete(requestId);
      this.progress.delete(requestId);
      this.settlingRequests.delete(requestId);
      this.options.onChange?.();
    }
  }

  private notifyModel(
    state: SettlementState,
    taskId: number,
    subject: string,
    agent: string,
    result: TaskDelegation['result'],
    listComplete: boolean,
  ): void {
    const notify = this.options.notify;
    if (!notify) return;

    const headline =
      state === COMPLETED_STATE
        ? `Subagent ${agent} completed task #${taskId}: ${subject}`
        : state === CANCELLED_STATE
          ? `Subagent ${agent} was cancelled on task #${taskId}: ${subject} (returned to pending)`
          : `Subagent ${agent} failed task #${taskId}: ${subject}`;

    const lines = [headline];
    if (listComplete) {
      lines.push(
        '',
        'All tasks are completed. Review the full task list once more, then close it with task {"action":"clear"}.',
      );
    }
    if (result?.error) lines.push(`Error: ${result.error}`);
    if (result?.output) lines.push('', result.output);
    if (result?.outputPath) lines.push('', `Full output: ${result.outputPath}`);

    try {
      notify(
        { customType: NOTIFY_CUSTOM_TYPE, content: lines.join('\n'), display: true },
        { triggerTurn: true, deliverAs: 'steer' },
      );
    } catch (error) {
      // The delegation state is already committed to the store, so a failed
      // notification costs the model its wake-up, not the result. Report it
      // rather than rethrowing, which would strand the settled run.
      this.options.onNotifyError(error, taskId);
    }
  }

  /**
   * Rewrite the task carrying `requestId`, returning the updated task as the mutation value.
   *
   * Terminal delegations are left alone. The document here is the freshest one,
   * read under the store lock, which is the only place the check is meaningful:
   * a `started` event can land after a cancel already settled the run, and
   * without this guard its write would resurrect a delegation that nothing is
   * tracking any more.
   */
  private patchDelegation(
    document: TaskDocument,
    requestId: string,
    patch: (task: Task, delegation: TaskDelegation) => Task,
  ): { document?: TaskDocument; value: Task | undefined } {
    const index = document.tasks.findIndex((task) => task.delegation?.requestId === requestId);
    if (index === -1) return { value: undefined };

    const task = document.tasks[index];
    if (!isDelegationActive(task)) return { value: task };

    const updated = patch(task, task.delegation!);
    if (updated === task) return { value: task };
    const tasks = [...document.tasks];
    tasks[index] = updated;
    return { document: { ...document, tasks }, value: updated };
  }

  dispose(): void {
    this.unbind();
    this.reset();
  }

  /** Clear one Pi session's transient delegation state without losing service injection. */
  reset(): void {
    const changed = this.pendingTasks.size > 0 || this.progress.size > 0;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingTasks.clear();
    this.settlingRequests.clear();
    this.progress.clear();
    if (changed) this.options.onChange?.();
  }
}
