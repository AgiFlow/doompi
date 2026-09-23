import type { DoomBackgroundWorkService } from '@agimon-ai/doompi-core/backgroundWork';
import type { PiEventHandlers, PiToolRestriction } from '@agimon-ai/doompi-core/piExtension';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { currentTokenTotal, updateGoalUsage } from '../../models/accounting';
import { GoalRuntimeModel } from '../../models/runtime';
import {
  classifyGoalRunFailure,
  nextToolFreeRepeatState,
  resetGoalSafetyEpoch,
  safetyLimitReached,
} from '../../models/safety';
import { loadGoalStateFromSession } from '../../models/stateCodec';
import {
  createGoal,
  formatStatus,
  incrementGoal,
  isResumableGoalStatus,
  transitionGoal,
} from '../../models/stateMachine';
import { GoalHistoryService } from '../../services/history';
import { GoalHistoryStore } from '../../services/historyStore';
import { parseGoalCommand, validateObjective } from '../../services/parser';
import {
  buildContinuePrompt,
  buildGoalPrompt,
  buildGoalSystemPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from '../../services/prompts';
import { DEFAULT_GOAL_SETTINGS, normalizeGoalSettings } from '../../services/settings';
import type { GoalExtensionDependencies, GoalExtensionService } from '../../types/extension';
import type { ActiveGoal, GoalRuntimeSnapshot, GoalStateData } from '../../types/goal';
import { formatGoalStatusView, GOAL_VIEW_STATUS_KEY } from '../../types/goalView';
import type { GoalHistoryEntry, GoalHistoryPort } from '../../types/history';
import { buildGoalCheckRequest, GOAL_CHECK_ENTRY, GOAL_CHECK_TIMEOUT_MS, parseGoalCheckResult } from '../goalChecker';
const STATUS_KEY = 'goal';
const SETTINGS_FILE = 'pi-goal.json';

type RunOrigin = 'manual' | 'automatic';
type AgentEndEventLike = { messages?: readonly unknown[] };
type CompactEventLike = { reason?: string; willRetry?: boolean };
type CompactState = { goalId: string; hadAutomaticRun: boolean; willRetry: boolean };
type BackgroundWorkBinding = {
  readonly token: symbol;
  readonly service: DoomBackgroundWorkService;
  readonly serviceGeneration: string;
};
type ContinuationLease = {
  readonly managerGeneration: number;
  readonly continuationGeneration: number;
  readonly executionGeneration: number;
  readonly goalId?: string;
  readonly runGoalId?: string;
  readonly sessionId?: string;
  readonly backgroundToken?: symbol;
  readonly backgroundServiceGeneration?: string;
};
export interface GoalStateEvent {
  readonly goalId: string;
  readonly status: string;
  readonly reason?: string;
  readonly summary?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GoalPiManager {
  private readonly pi: ExtensionAPI;
  private readonly runtime: GoalRuntimeModel;
  private readonly dependencies?: GoalExtensionDependencies;
  private readonly legacyCommandService?: GoalExtensionService;
  private context?: ExtensionContext;
  private sessionId?: string;
  private generation = 0;
  private operations: Promise<void> = Promise.resolve();
  private settings = DEFAULT_GOAL_SETTINGS;
  private history?: GoalHistoryPort;
  private runGoalId?: string;
  private runOrigin?: RunOrigin;
  private runExecutionGeneration?: number;
  private pendingRunOrigin: RunOrigin = 'manual';
  private executionGeneration = 0;
  private compactState?: CompactState;
  private lastGoalId?: string;
  private runToolAttempted = false;
  private readyForCheck = false;
  private disposed = false;
  private backgroundWork?: BackgroundWorkBinding;
  private checkController?: AbortController;
  private continuationGeneration = 0;
  private readonly disposers: Array<() => void> = [];
  private readonly stateListeners = new Set<(event: GoalStateEvent) => void>();
  constructor(pi: ExtensionAPI, dependencies?: GoalExtensionDependencies, legacyCommandService?: GoalExtensionService) {
    this.pi = pi;
    this.dependencies = dependencies;
    this.legacyCommandService = legacyCommandService;
    this.runtime = new GoalRuntimeModel({
      persist: (state: GoalStateData) => this.pi.appendEntry('goal-state', state),
    });
  }

  public snapshot(): GoalRuntimeSnapshot {
    return this.runtime.snapshot();
  }

  public subscribeState(listener: (event: GoalStateEvent) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public bindBackgroundWork(service: DoomBackgroundWorkService): () => void {
    const binding: BackgroundWorkBinding = {
      token: Symbol(service.generation),
      service,
      serviceGeneration: service.generation,
    };
    this.backgroundWork = binding;
    this.invalidateContinuation();
    if (this.context) this.scheduleContinuation(this.context);
    return () => {
      if (this.backgroundWork?.token !== binding.token) return;
      this.backgroundWork = undefined;
      this.invalidateContinuation();
    };
  }

  public toolRestrictions(): readonly PiToolRestriction[] {
    return [];
  }

  public backgroundWorkChanged(service: DoomBackgroundWorkService): void {
    const binding = this.backgroundWork;
    if (!binding || binding.service !== service || binding.serviceGeneration !== service.generation) return;
    this.invalidateContinuation();
    if (this.context) this.scheduleContinuation(this.context);
  }

  public async startFromLeader(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== 'tui') {
      this.notify('Goal leader actions require the Doom TUI.', 'warning');
      return;
    }
    const draft = ctx.ui.getEditorText();
    if (draft.length > 0) {
      const accepted = await ctx.ui.confirm(
        'Replace editor draft?',
        'Goal start will replace the current draft with /goal .',
      );
      if (!accepted) return;
    }
    ctx.ui.setEditorText('/goal ');
  }

  public async startFromCatalog(objective: string, budget: number | undefined, ctx: ExtensionContext): Promise<void> {
    this.invalidateContinuation();
    await this.ensureSession(ctx);
    await this.enqueue(() => this.startGoal(objective, budget, ctx as ExtensionCommandContext));
  }

  public async endFromLeader(ctx: ExtensionContext): Promise<void> {
    this.invalidateContinuation();
    await this.ensureSession(ctx);
    await this.enqueue(() => this.clearGoal(ctx));
  }

  public async showFromLeader(ctx: ExtensionContext): Promise<void> {
    await this.ensureSession(ctx);
    this.showStatus();
  }

  public async listHistory(ctx: ExtensionContext): Promise<GoalHistoryEntry[]> {
    await this.ensureSession(ctx);
    return (await this.history?.list()) ?? [];
  }

  public async restartFromHistory(id: string, ctx: ExtensionContext): Promise<void> {
    this.invalidateContinuation();
    await this.ensureSession(ctx);
    if (!this.history) {
      this.notify('Goal history is unavailable.', 'error');
      return;
    }
    try {
      const restart = await this.history.restart(id);
      await this.enqueue(() =>
        this.startGoal(restart.objective, restart.budget, ctx as ExtensionCommandContext, restart.goalId),
      );
    } catch (error) {
      this.notify(`Goal history restart failed: ${errorText(error)}`, 'error');
    }
  }

  public async removeHistory(id: string, ctx: ExtensionContext): Promise<void> {
    await this.ensureSession(ctx);
    if (!this.history) {
      this.notify('Goal history is unavailable.', 'error');
      return;
    }
    try {
      await this.history.remove(id);
      this.notify('Goal history entry removed.', 'info');
    } catch (error) {
      this.notify(`Goal history removal failed: ${errorText(error)}`, 'error');
    }
  }

  private async ensureSession(ctx: ExtensionContext): Promise<void> {
    if (this.isCurrent(ctx)) return;
    await this.enqueue(() => this.startSession(ctx));
  }

  commands(): readonly Parameters<ExtensionAPI['registerCommand']>[] {
    return [
      [
        'goal',
        {
          description: 'Manage persistent goal execution',
          handler: (args, ctx) => {
            const parsed = parseGoalCommand(args);
            if (typeof parsed !== 'string' && parsed.kind !== 'show') this.invalidateContinuation();
            return this.enqueue(() => this.executeCommand(args, ctx));
          },
        },
      ],
    ];
  }
  events(): PiEventHandlers {
    return {
      session_start: (_event, ctx) => {
        this.fenceExecution();
        return this.enqueue(() => this.startSession(ctx));
      },
      session_tree: (_event, ctx) => {
        this.fenceExecution();
        return this.enqueue(() => this.startSession(ctx));
      },
      model_select: (_event, ctx) => {
        this.invalidateContinuation();
        this.scheduleContinuation(ctx);
      },
      session_shutdown: () => {
        this.fenceExecution();
        this.generation += 1;
        this.context = undefined;
        this.sessionId = undefined;
        this.runGoalId = undefined;
        this.runOrigin = undefined;
        this.runExecutionGeneration = undefined;
        this.runToolAttempted = false;
        this.compactState = undefined;
      },
      input: () => {
        this.invalidateContinuation();
        this.readyForCheck = false;
      },
      before_agent_start: (event, ctx) => {
        if (!this.isCurrent(ctx)) return undefined;
        this.invalidateContinuation();
        const goal = this.runtime.snapshot().goal;
        if (!goal || goal.status !== 'active') return undefined;
        const prompt = buildGoalSystemPrompt(goal);
        return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
      },
      agent_start: (_event, ctx) => {
        if (!this.isCurrent(ctx)) return;
        this.invalidateContinuation();
        this.readyForCheck = false;
        const goal = this.runtime.snapshot().goal;
        this.runGoalId = goal?.status === 'active' ? goal.id : undefined;
        this.runOrigin = this.runGoalId ? this.pendingRunOrigin : undefined;
        this.runExecutionGeneration = this.runGoalId ? this.executionGeneration : undefined;
        this.pendingRunOrigin = 'manual';
        this.runToolAttempted = false;
      },
      tool_call: (event, ctx) => {
        if (!this.isCurrent(ctx)) return undefined;
        this.noteToolCall(event.toolName);
        return undefined;
      },
      tool_execution_start: (event, ctx) => {
        if (!this.isCurrent(ctx)) return;
        this.noteToolCall(event.toolName);
      },
      agent_end: (event, ctx) => {
        void this.enqueue(() => this.finishAgentRun(event, ctx)).catch((error: unknown) =>
          this.notify(`Goal settlement failed: ${errorText(error)}`, 'error'),
        );
      },
      agent_settled: (_event, ctx) => {
        this.scheduleContinuation(ctx);
      },
      session_before_compact: (event, ctx) => this.beforeCompact(event, ctx),
      session_compact: (event, ctx) => {
        void this.enqueue(() => this.afterCompact(event, ctx));
      },
    };
  }
  tools(): readonly ToolDefinition[] {
    return [];
  }

  private async startSession(ctx: ExtensionContext): Promise<void> {
    this.fenceExecution();
    this.generation += 1;
    const activeGeneration = this.generation;
    this.context = ctx;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.runGoalId = undefined;
    this.runOrigin = undefined;
    this.runExecutionGeneration = undefined;
    this.runToolAttempted = false;
    this.pendingRunOrigin = 'manual';
    this.settings = await this.loadSettings();
    this.history = this.dependencies?.history ?? this.createHistory(ctx.cwd);
    const loaded = loadGoalStateFromSession({ sessionManager: ctx.sessionManager });
    this.runtime.load(loaded.goal);
    if (activeGeneration !== this.generation) return;
    const goal = this.runtime.snapshot().goal;
    if (goal?.status === 'active') {
      this.runGoalId = goal.id;
      this.runExecutionGeneration = this.executionGeneration;
      this.readyForCheck = true;
      this.scheduleContinuation(ctx);
    }
    this.refreshStatus();
    this.emitState();
  }

  private createHistory(cwd: string): GoalHistoryPort | undefined {
    try {
      return new GoalHistoryService(new GoalHistoryStore(cwd));
    } catch {
      return undefined;
    }
  }

  private async loadSettings(): Promise<typeof DEFAULT_GOAL_SETTINGS> {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = JSON.parse(await fs.readFile(path.join(getAgentDir(), SETTINGS_FILE), 'utf8')) as unknown;
      return normalizeGoalSettings(raw) ?? DEFAULT_GOAL_SETTINGS;
    } catch {
      return DEFAULT_GOAL_SETTINGS;
    }
  }

  private isCurrent(ctx: ExtensionContext): boolean {
    return !this.disposed && this.context === ctx && this.sessionId === ctx.sessionManager.getSessionId();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operations.then(operation, operation);
    this.operations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private fenceExecution(): void {
    this.executionGeneration += 1;
    this.invalidateContinuation();
    this.readyForCheck = false;
    this.runGoalId = undefined;
    this.runOrigin = undefined;
    this.runExecutionGeneration = undefined;
    this.runToolAttempted = false;
    this.compactState = undefined;
  }

  private invalidateContinuation(): void {
    this.continuationGeneration += 1;
    this.checkController?.abort();
  }

  private scheduleContinuation(ctx: ExtensionContext): void {
    const goal = this.runtime.snapshot().goal;
    const binding = this.backgroundWork;
    const lease: ContinuationLease = {
      managerGeneration: this.generation,
      continuationGeneration: this.continuationGeneration,
      executionGeneration: this.executionGeneration,
      goalId: goal?.id,
      runGoalId: this.runGoalId,
      sessionId: this.sessionId,
      ...(binding ? { backgroundToken: binding.token, backgroundServiceGeneration: binding.serviceGeneration } : {}),
    };
    void this.enqueue(() => this.continueAfterSettled(ctx, lease));
  }

  private noteToolCall(_toolName: string): void {
    this.runToolAttempted = true;
  }

  private beforeCompact(event: CompactEventLike, ctx: ExtensionContext): undefined {
    if (!this.isCurrent(ctx)) return undefined;
    const goal = this.runtime.snapshot().goal;
    if (!goal || goal.status !== 'active') return undefined;
    this.compactState = {
      goalId: goal.id,
      hadAutomaticRun: this.runOrigin === 'automatic' && this.runGoalId === goal.id,
      willRetry: event.willRetry === true,
    };
    // A compaction invalidates the current turn's leases. The persisted Goal remains
    // authoritative, while a retry/settled boundary may establish a new lease.
    this.executionGeneration += 1;
    this.invalidateContinuation();
    this.readyForCheck = false;
    this.runGoalId = undefined;
    this.runOrigin = undefined;
    this.runExecutionGeneration = undefined;
    return undefined;
  }

  private async afterCompact(event: CompactEventLike, ctx: ExtensionContext): Promise<void> {
    if (!this.isCurrent(ctx)) return;
    const compact = this.compactState;
    if (!compact) return;
    const goal = this.runtime.snapshot().goal;
    this.compactState = undefined;
    if (!goal || goal.id !== compact.goalId || goal.status !== 'active') return;
    this.executionGeneration += 1;
    this.runToolAttempted = false;
    // Overflow retries belong to Pi's current run and must not receive a duplicate
    // continuation. Manual/threshold compaction keeps one guarded recovery marker.
    if (!compact.willRetry && event.willRetry !== true) {
      this.runGoalId = goal.id;
      this.runOrigin = compact.hadAutomaticRun ? 'automatic' : 'manual';
      this.runExecutionGeneration = this.executionGeneration;
      this.readyForCheck = true;
      this.scheduleContinuation(ctx);
    }
  }

  /**
   * The two statuses this package publishes.
   *
   * STATUS_KEY is the terminal footer's: short enough to sit beside every other
   * extension's. GOAL_VIEW_STATUS_KEY carries the objective itself for the
   * cockpit's activity dock, and is published only to a client that is not a
   * terminal, because a footer already saying `active 4m` gains nothing from
   * the same goal spelled out again beside it.
   */
  private refreshStatus(): void {
    const ctx = this.context;
    if (!ctx?.hasUI) return;
    const goal = this.runtime.snapshot().goal;
    const state = formatStatus(goal);
    ctx.ui.setStatus(STATUS_KEY, state);
    if (ctx.mode === 'tui') return;
    ctx.ui.setStatus(GOAL_VIEW_STATUS_KEY, goal ? formatGoalStatusView(goal.text, state ?? goal.status) : undefined);
  }

  private emitState(reason?: string, summary?: string): void {
    const goal = this.runtime.snapshot().goal;
    const status = goal?.status ?? 'cleared';
    this.lastGoalId = goal?.id ?? this.lastGoalId;
    const event: GoalStateEvent = {
      goalId: goal?.id ?? this.lastGoalId ?? '',
      status,
      ...(reason ? { reason } : {}),
      ...(summary ? { summary } : {}),
    };
    for (const listener of this.stateListeners) listener(event);
  }

  private notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (this.context?.hasUI) this.context.ui.notify(message, level);
  }

  private abortCurrentTurn(ctx: ExtensionContext): boolean {
    try {
      ctx.abort();
      return true;
    } catch {
      return false;
    }
  }

  private async executeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const hasSessionManager = Object.hasOwn(ctx, 'sessionManager');
    if (!args.trim() && this.legacyCommandService && !hasSessionManager) {
      const result = await this.legacyCommandService.execute();
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
      return;
    }
    if (!this.isCurrent(ctx)) {
      await this.startSession(ctx);
    }
    const parsed = parseGoalCommand(args);
    if (typeof parsed === 'string') {
      this.notify(parsed, 'warning');
      return;
    }
    switch (parsed.kind) {
      case 'show':
        this.showStatus();
        return;
      case 'start':
        await this.startGoal(parsed.objective ?? '', parsed.tokenBudget, ctx);
        return;
      case 'pause':
        this.pauseGoal(ctx);
        return;
      case 'resume':
        await this.resumeGoal(ctx);
        return;
      case 'clear':
        await this.clearGoal(ctx);
        return;
      case 'edit':
        await this.editGoal(parsed.objective ?? '', parsed.tokenBudget, ctx);
        return;
    }
  }

  private showStatus(): void {
    const goal = this.runtime.snapshot().goal;
    if (!goal) {
      this.notify('No active goal.', 'info');
      return;
    }
    this.notify(`Goal: ${goal.text}\nStatus: ${goal.status}`, 'info');
  }

  private async startGoal(
    objective: string,
    budget: number | undefined,
    ctx: ExtensionCommandContext,
    goalId?: string,
  ): Promise<void> {
    const validation = validateObjective(objective);
    if (validation) {
      this.notify(validation, 'warning');
      return;
    }
    const previous = this.runtime.snapshot();
    const oldGoal = previous.goal && previous.goal.status !== 'complete' ? previous.goal : undefined;
    if (oldGoal) {
      const accepted = await ctx.ui.confirm('Replace goal?', `Current goal: ${oldGoal.text}\n\nNew goal: ${objective}`);
      if (!accepted) return;
      if (!(await this.archiveAll([oldGoal], 'replaced'))) {
        this.notify('Goal replacement aborted because history archival failed.', 'error');
        return;
      }
    }
    const next = createGoal(objective, budget, { id: goalId, baselineTokens: currentTokenTotal(ctx) });
    this.fenceExecution();
    this.runtime.replaceState(next);
    this.pendingRunOrigin = 'manual';
    this.runGoalId = next.id;
    this.runExecutionGeneration = this.executionGeneration;
    this.refreshStatus();
    this.emitState();
    try {
      this.pi.sendUserMessage(buildGoalPrompt(next), { deliverAs: 'followUp' });
    } catch (error) {
      this.runtime.replaceState(oldGoal);
      this.fenceExecution();
      this.refreshStatus();
      this.notify(`Goal kickoff failed: ${errorText(error)}`, 'error');
      return;
    }
    this.notify(oldGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`);
  }

  private pauseGoal(ctx: ExtensionContext): void {
    const goal = this.runtime.snapshot().goal;
    if (!goal) {
      this.notify('No active goal.');
      return;
    }
    if (goal.status !== 'active') {
      this.notify(`Goal is ${goal.status}; only active goals can be paused.`, 'warning');
      return;
    }
    updateGoalUsage(goal, ctx, Date.now(), false);
    this.fenceExecution();
    const next = transitionGoal({ ...goal }, 'paused');
    this.runtime.replaceState(next);
    ctx.abort();
    this.refreshStatus();
    this.emitState('paused');
    this.notify(`Goal paused: ${goal.text}`);
  }

  private async resumeGoal(ctx: ExtensionContext): Promise<void> {
    const goal = this.runtime.snapshot().goal;
    if (!goal) {
      this.notify('No active goal.');
      return;
    }
    if (!isResumableGoalStatus(goal.status)) {
      this.notify(`Goal is ${goal.status}; it cannot be resumed.`, 'warning');
      return;
    }
    updateGoalUsage(goal, ctx, Date.now(), false);
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      this.notify('Goal token budget is still reached.', 'warning');
      return;
    }
    const next = resetGoalSafetyEpoch(transitionGoal({ ...goal, updatedAt: Date.now() }, 'active'));
    this.fenceExecution();
    this.runtime.replaceState(next);
    this.pendingRunOrigin = 'manual';
    this.runGoalId = next.id;
    this.runExecutionGeneration = this.executionGeneration;
    this.refreshStatus();
    this.emitState();
    try {
      this.pi.sendUserMessage(buildResumePrompt(next, goal.status), { deliverAs: 'followUp' });
    } catch (error) {
      this.fenceExecution();
      this.runtime.replaceState(goal);
      this.refreshStatus();
      this.notify(`Goal resume failed: ${errorText(error)}`, 'error');
    }
  }

  private async clearGoal(ctx: ExtensionContext): Promise<void> {
    const snapshot = this.runtime.snapshot();
    if (!(await this.archiveAll(snapshot.goal ? [snapshot.goal] : [], 'cleared'))) {
      this.notify('Goal clear aborted because history archival failed.', 'error');
      return;
    }
    this.fenceExecution();
    this.runtime.clear();
    if (snapshot.goal) ctx.abort();
    this.refreshStatus();
    this.emitState('cleared');
    if (snapshot.goal) this.notify(`Goal cleared: ${snapshot.goal.text}`, 'warning');
    else this.notify('No active goal.', 'info');
  }

  private async editGoal(objective: string, budget: number | undefined, ctx: ExtensionCommandContext): Promise<void> {
    const validation = validateObjective(objective);
    if (validation) {
      this.notify(validation, 'warning');
      return;
    }
    const goal = this.runtime.snapshot().goal;
    if (!goal) {
      this.notify('No active goal. Use /goal <objective> to start one.', 'warning');
      return;
    }
    this.invalidateContinuation();
    this.readyForCheck = false;
    const next = {
      ...goal,
      text: objective,
      ...(budget === undefined ? {} : { tokenBudget: budget }),
      updatedAt: Date.now(),
    };
    this.runtime.replaceState(next);
    this.refreshStatus();
    this.emitState();
    if (goal.status === 'active') this.pi.sendUserMessage(buildObjectiveUpdatedPrompt(next), { deliverAs: 'followUp' });
    else this.notify(`Goal updated but remains ${goal.status}. Resume explicitly to execute it.`);
    void ctx;
  }

  private async finishAgentRun(event: AgentEndEventLike, ctx: ExtensionContext): Promise<void> {
    if (!this.isCurrent(ctx)) return;
    const snapshot = this.runtime.snapshot();
    const goal = snapshot.goal;
    if (!goal || goal.status !== 'active') return;
    if (this.runGoalId !== goal.id || this.runExecutionGeneration !== this.executionGeneration) {
      this.fenceExecution();
      return;
    }

    const messages = event.messages ?? [];
    const failure = classifyGoalRunFailure(messages);
    updateGoalUsage(goal, ctx, Date.now(), true);
    if (failure === 'aborted') {
      this.fenceExecution();
      this.runtime.replaceState(transitionGoal({ ...goal }, 'paused'));
      this.refreshStatus();
      this.emitState('cancelled');
      return;
    }
    if (failure === 'usage_limited' || failure === 'blocked') {
      this.fenceExecution();
      const stopped = transitionGoal({ ...goal }, failure);
      this.runtime.replaceState(stopped);
      this.abortCurrentTurn(ctx);
      this.refreshStatus();
      this.emitState(failure === 'usage_limited' ? 'provider usage limit' : 'provider error');
      this.notify(
        failure === 'usage_limited'
          ? 'Goal paused because the provider usage limit was reached. Run /goal resume after it resets.'
          : 'Goal blocked because the provider reported a terminal error. Resolve it or run /goal resume.',
        'warning',
      );
      return;
    }

    if (this.runOrigin === 'automatic') {
      goal.automaticModelTurns = Math.min(Number.MAX_SAFE_INTEGER, goal.automaticModelTurns + 1);
      const progress = nextToolFreeRepeatState(goal, messages, this.runToolAttempted);
      goal.toolFreeRepeatCount = progress.toolFreeRepeatCount;
      goal.lastToolFreeOutputFingerprint = progress.lastToolFreeOutputFingerprint;
    }

    // The final idle check may still prove completion at a limit, but cannot admit more work.
    this.runtime.replaceState(
      goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget
        ? transitionGoal({ ...goal }, 'budget_limited')
        : goal,
    );
    this.readyForCheck = true;
    this.refreshStatus();
  }

  private goalForCheck(ctx: ExtensionContext, lease: ContinuationLease): ActiveGoal | undefined {
    if (!this.readyForCheck || !this.isCurrent(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) return undefined;
    if (
      lease.managerGeneration !== this.generation ||
      lease.continuationGeneration !== this.continuationGeneration ||
      lease.executionGeneration !== this.executionGeneration ||
      lease.sessionId !== this.sessionId ||
      lease.runGoalId !== this.runGoalId
    )
      return undefined;
    const goal = this.runtime.snapshot().goal;
    if (
      !goal ||
      goal.id !== lease.goalId ||
      !['active', 'budget_limited'].includes(goal.status) ||
      this.runGoalId !== goal.id ||
      this.runExecutionGeneration !== this.executionGeneration ||
      this.backgroundWorkBlocks(lease)
    )
      return undefined;
    return goal;
  }

  private async continueAfterSettled(ctx: ExtensionContext, lease: ContinuationLease): Promise<void> {
    const goal = this.goalForCheck(ctx, lease);
    if (!goal || this.checkController) return;
    const controller = new AbortController();
    this.checkController = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(GOAL_CHECK_TIMEOUT_MS)]);
    // Inference never owns the operation queue: commands can pause, edit, or clear while it runs.
    void this.checkWithPi(ctx, goal, signal)
      .then((result) =>
        this.enqueue(async () => {
          if (!this.isCurrent(ctx)) return;
          const current = this.goalForCheck(ctx, lease);
          this.pi.appendEntry(GOAL_CHECK_ENTRY, { goalId: goal.id, ...result, discarded: !current });
          if (!current || signal.aborted) return;
          updateGoalUsage(current, ctx);
          const decision = parseGoalCheckResult(current, result);
          if (decision.tool === 'goal_complete') {
            const summary = `${decision.summary}\n\nEvidence: ${decision.evidence}`;
            if (!(await this.archive(current, 'complete', summary))) throw new Error('Goal history archival failed.');
            if (!this.goalForCheck(ctx, lease) || signal.aborted) return;
            this.fenceExecution();
            this.runtime.clear();
            this.refreshStatus();
            this.emitState(undefined, summary);
            this.notify(`Goal complete: ${current.text}`);
            return;
          }
          if (decision.tool === 'goal_blocked') {
            this.fenceExecution();
            this.runtime.replaceState(transitionGoal({ ...current }, 'blocked'));
            this.refreshStatus();
            this.emitState(decision.reason);
            this.notify(`Goal blocked: ${decision.reason}`, 'warning');
            return;
          }
          if (current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget) {
            this.limitForBudget(ctx, current);
            return;
          }
          const cause = safetyLimitReached(current, this.settings.continuationLimits);
          if (cause) {
            this.pauseForSafety(ctx, current, cause);
            return;
          }
          const next = incrementGoal({ ...current });
          this.fenceExecution();
          this.runtime.replaceState(next);
          this.pendingRunOrigin = 'automatic';
          try {
            this.pi.sendUserMessage(buildContinuePrompt(next, decision.instruction), { deliverAs: 'followUp' });
          } catch (error) {
            this.pauseForDeliveryFailure(ctx, current, `Goal continuation failed: ${errorText(error)}`);
          }
        }),
      )
      .catch((error: unknown) =>
        this.enqueue(async () => {
          const current = this.goalForCheck(ctx, lease);
          if (current && !controller.signal.aborted)
            this.pauseForDeliveryFailure(
              ctx,
              current,
              `Goal check failed: ${errorText(error)} Run /goal resume to retry.`,
            );
        }),
      )
      .finally(() => {
        if (this.checkController !== controller) return;
        this.checkController = undefined;
        if (controller.signal.aborted && this.isCurrent(ctx)) this.scheduleContinuation(ctx);
      })
      .catch((error: unknown) => this.notify(`Goal check cleanup failed: ${errorText(error)}`, 'error'));
  }

  private async checkWithPi(ctx: ExtensionContext, goal: ActiveGoal, signal: AbortSignal) {
    const request = buildGoalCheckRequest(goal, ctx.sessionManager.getBranch(), signal);
    const model = ctx.model;
    if (!model) throw new Error('No active model is available for the Goal check.');
    signal.throwIfAborted();
    const response = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: 'user', content: request.input, timestamp: Date.now() }],
          tools: [...request.tools],
        },
        { signal, maxTokens: request.maxTokens, cacheRetention: request.cacheRetention, maxRetries: 0 },
      )
      .result();
    signal.throwIfAborted();
    if (response.stopReason === 'error' || response.stopReason === 'aborted' || response.stopReason === 'length')
      throw new Error(response.errorMessage ?? `Goal checker stopped: ${response.stopReason}`);
    return { toolCalls: response.content.filter((part) => part.type === 'toolCall'), usage: response.usage };
  }

  private backgroundWorkBlocks(lease: ContinuationLease): boolean {
    const binding = this.backgroundWork;
    if (!binding) return true;
    if (
      binding.token !== lease.backgroundToken ||
      binding.serviceGeneration !== lease.backgroundServiceGeneration ||
      binding.service.generation !== binding.serviceGeneration
    )
      return true;
    try {
      const snapshot = binding.service.snapshot(this.sessionId);
      if (this.backgroundWork?.token !== binding.token) return true;
      return snapshot.items.length > 0 || snapshot.errors.length > 0;
    } catch {
      return true;
    }
  }

  private pauseForSafety(ctx: ExtensionContext, goal: ActiveGoal, cause: 'continuation_limit' | 'no_progress'): void {
    if (this.runtime.snapshot().goal?.id !== goal.id) return;
    this.fenceExecution();
    const paused = transitionGoal({ ...goal, safetyPauseCause: cause }, 'paused');
    this.runtime.replaceState(paused);
    this.abortCurrentTurn(ctx);
    this.refreshStatus();
    this.emitState(cause === 'continuation_limit' ? 'automatic response limit' : 'no progress');
    const detail = cause === 'continuation_limit' ? 'automatic response limit' : 'no progress';
    this.notify(`Goal paused by safety limit: ${detail}. Run /goal resume to continue.`, 'warning');
  }

  private limitForBudget(_ctx: ExtensionContext, goal: ActiveGoal): void {
    this.fenceExecution();
    this.runtime.replaceState(transitionGoal({ ...goal }, 'budget_limited'));
    this.refreshStatus();
    this.emitState('token budget reached');
    this.notify('Goal token budget reached. The unfinished goal has been retained.', 'warning');
  }

  private pauseForDeliveryFailure(ctx: ExtensionContext, goal: ActiveGoal, message: string): void {
    this.fenceExecution();
    const paused = transitionGoal({ ...goal }, 'paused');
    this.runtime.replaceState(paused);
    this.abortCurrentTurn(ctx);
    this.refreshStatus();
    this.emitState('delivery failed');
    this.notify(message, 'error');
  }

  private async archiveAll(goals: readonly ActiveGoal[], reason: string): Promise<boolean> {
    const seen = new Set<string>();
    for (const goal of goals) {
      if (seen.has(goal.id)) continue;
      seen.add(goal.id);
      if (!(await this.archive(goal, reason))) return false;
    }
    return true;
  }

  private async archive(goal: ActiveGoal, reason: string, summary?: string): Promise<boolean> {
    if (!this.history) {
      this.notify('Goal history is unavailable; the goal has been retained.', 'error');
      return false;
    }
    try {
      await this.history.archive({
        id: goal.id,
        objective: goal.text,
        status: reason === 'complete' ? 'complete' : goal.status,
        ...(summary ? { reason: summary } : { reason }),
        ...(goal.tokenBudget === undefined ? {} : { budget: goal.tokenBudget }),
        archivedAt: new Date().toISOString(),
        startedAt: new Date(goal.startedAt).toISOString(),
        ...(reason === 'complete' ? { completedAt: new Date().toISOString() } : {}),
      });
      return true;
    } catch (error) {
      this.notify(`Goal history archival failed: ${errorText(error)}`, 'error');
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fenceExecution();
    this.generation += 1;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.stateListeners.clear();
    this.context = undefined;
  }
}
