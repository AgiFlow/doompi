import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { currentTokenTotal, updateGoalUsage } from '../../services/accounting.ts';
import { parseGoalCommand, validateObjective } from '../../services/parser.ts';
import {
  buildContinuePrompt,
  buildGoalPrompt,
  buildGoalSystemPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from '../../services/prompts.ts';
import { enqueueGoal, promoteNextGoal, skipCurrentGoal } from '../../services/queue.ts';
import { GoalRuntimeModel } from '../../services/runtime.ts';
import { nextToolFreeRepeatState, resetGoalSafetyEpoch, safetyLimitReached } from '../../services/safety.ts';
import { DEFAULT_GOAL_SETTINGS, normalizeGoalSettings } from '../../services/settings.ts';
import { loadGoalStateFromSession } from '../../services/stateCodec.ts';
import {
  createGoal,
  formatStatus,
  incrementGoal,
  isContradictoryCompletionSummary,
  isResumableGoalStatus,
  transitionGoal,
} from '../../services/stateMachine.ts';
import { validateBlockedInput, validateCompletionInput } from '../../services/tools.ts';
import { GoalHistoryService } from '../../services/history/historyService.ts';
import type { GoalExtensionDependencies, GoalExtensionService } from '../../types/extension.ts';
import type { ActiveGoal, GoalRuntimeSnapshot, GoalStateData } from '../../types/goal.ts';
import type { GoalHistoryEntry, GoalHistoryPort } from '../../types/history.ts';
import { GoalHistoryStore } from '../node/historyStore.ts';
import { canExecuteGoalTools, reconcileGoalTools, removeGoalTools } from './toolVisibility.ts';

const COMPLETE_TOOL = 'goal_complete';
const BLOCKED_TOOL = 'goal_blocked';
const STATUS_KEY = 'goal';
const SETTINGS_FILE = 'pi-goal.json';

const COMPLETE_PARAMETERS = {
  type: 'object',
  properties: {
    goal_id: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
  },
  required: ['goal_id', 'summary'],
  additionalProperties: false,
} as const;

const BLOCKED_PARAMETERS = {
  type: 'object',
  properties: {
    goal_id: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1 },
    repeated_turns: { type: 'integer', minimum: 3 },
  },
  required: ['goal_id', 'reason', 'evidence', 'repeated_turns'],
  additionalProperties: false,
} as const;

type CompleteInput = { goal_id?: unknown; summary?: unknown };
type BlockedInput = { goal_id?: unknown; reason?: unknown; evidence?: unknown; repeated_turns?: unknown };
type ToolResult = AgentToolResult<Record<string, unknown>>;
type RunOrigin = 'manual' | 'automatic';
type AgentEndEventLike = { messages?: readonly unknown[] };
type CompactEventLike = { reason?: string; willRetry?: boolean };
type CompactState = { goalId: string; hadAutomaticRun: boolean; willRetry: boolean };

export interface GoalStateEvent {
  readonly goalId: string;
  readonly status: string;
  readonly reason?: string;
  readonly summary?: string;
}

function messageResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], details: { error: isError } };
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
  private lastToolCallGoalId?: string;
  private lastToolCallGeneration?: number;
  private executionGeneration = 0;
  private compactState?: CompactState;
  private budgetWrapUpGoalId?: string;
  private lastGoalId?: string;
  private runToolAttempted = false;
  private disposed = false;
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
    await this.ensureSession(ctx);
    await this.enqueue(() => this.startGoal(objective, budget, ctx as ExtensionCommandContext));
  }

  public async endFromLeader(ctx: ExtensionContext): Promise<void> {
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

  register(): () => void {
    if (typeof this.pi.registerTool === 'function') this.registerTools();
    this.pi.registerCommand('goal', {
      description: 'Manage persistent goal execution',
      handler: (args, ctx) => this.enqueue(() => this.executeCommand(args, ctx)),
    });
    this.pi.on('session_start', (_event, ctx) => this.enqueue(() => this.startSession(ctx)));
    this.pi.on('session_shutdown', () => {
      this.fenceExecution();
      this.generation += 1;
      this.context = undefined;
      this.sessionId = undefined;
      this.runGoalId = undefined;
      this.runOrigin = undefined;
      this.runExecutionGeneration = undefined;
      this.runToolAttempted = false;
      this.compactState = undefined;
      this.deactivateTools();
    });
    this.pi.on('before_agent_start', (event, ctx) => {
      if (!this.isCurrent(ctx)) return undefined;
      const goal = this.runtime.snapshot().goal;
      if (!goal || goal.status !== 'active') return undefined;
      if (!canExecuteGoalTools(this.pi, goal)) {
        this.pauseForToolPolicyDrift(ctx, goal);
        return undefined;
      }
      const prompt = buildGoalSystemPrompt(goal);
      return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
    });
    this.pi.on('agent_start', (_event, ctx) => {
      if (!this.isCurrent(ctx)) return;
      const goal = this.runtime.snapshot().goal;
      this.runGoalId = goal?.status === 'active' ? goal.id : undefined;
      this.runOrigin = this.runGoalId ? this.pendingRunOrigin : undefined;
      this.runExecutionGeneration = this.runGoalId ? this.executionGeneration : undefined;
      this.pendingRunOrigin = 'manual';
      this.runToolAttempted = false;
    });
    this.pi.on('tool_call', (event, ctx) => {
      if (!this.isCurrent(ctx)) return undefined;
      this.noteToolCall(event.toolName);
      return undefined;
    });
    this.pi.on('tool_execution_start', (event, ctx) => {
      if (!this.isCurrent(ctx)) return;
      this.noteToolCall(event.toolName);
    });
    this.pi.on('agent_end', (event, ctx) => {
      void this.enqueue(() => this.finishAgentRun(event, ctx));
    });
    this.pi.on('agent_settled', (_event, ctx) => {
      void this.enqueue(async () => {
        if (await this.dispatchPendingQueueAction(ctx)) return;
        await this.continueAfterSettled(ctx);
      });
    });
    this.pi.on('session_before_compact', (event, ctx) => this.beforeCompact(event, ctx));
    this.pi.on('session_compact', (event, ctx) => {
      void this.enqueue(() => this.afterCompact(event, ctx));
    });
    return () => this.dispose();
  }

  private registerTools(): void {
    const complete = {
      name: COMPLETE_TOOL,
      label: 'Goal complete',
      description: 'Mark the active Goal complete after verifying every requirement.',
      promptSnippet: 'Complete an active Goal after authoritative verification.',
      parameters: COMPLETE_PARAMETERS,
      execute: async (
        _toolCallId: string,
        params: CompleteInput,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<ToolResult> => this.enqueue(() => this.complete(params, ctx)),
    } as unknown as ToolDefinition;
    const blocked = {
      name: BLOCKED_TOOL,
      label: 'Goal blocked',
      description: 'Mark the active Goal blocked after the same external blocker recurs with evidence.',
      promptSnippet: 'Report a repeated external blocker for the active Goal.',
      parameters: BLOCKED_PARAMETERS,
      execute: async (
        _toolCallId: string,
        params: BlockedInput,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<ToolResult> => this.enqueue(() => this.blocked(params, ctx)),
    } as unknown as ToolDefinition;
    this.pi.registerTool(complete);
    this.pi.registerTool(blocked);
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
    this.budgetWrapUpGoalId = undefined;
    this.settings = await this.loadSettings();
    this.history = this.dependencies?.history ?? this.createHistory(ctx.cwd);
    const loaded = loadGoalStateFromSession({ sessionManager: ctx.sessionManager });
    this.runtime.load(loaded);
    this.deactivateTools();
    let goal = this.runtime.snapshot().goal;
    if (loaded.hasExperimentalQueueState && !this.settings.experimental.goals && goal?.status === 'active') {
      goal = transitionGoal({ ...goal }, 'paused');
      this.runtime.replaceState({
        goal,
        queue: [...this.runtime.snapshot().queue],
        pendingAction: this.runtime.snapshot().pendingAction,
      });
    }
    if (goal?.status === 'active') {
      const activated = this.activateTools(goal);
      if (!activated) {
        this.runtime.replaceState({ goal: transitionGoal(goal, 'paused'), queue: [...this.runtime.snapshot().queue] });
        this.notify('Goal paused because host policy does not expose both Goal tools.', 'warning');
      }
    }
    if (activeGeneration !== this.generation) return;
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

  private activateTools(goal: ActiveGoal): boolean {
    if (typeof this.pi.getActiveTools !== 'function' || typeof this.pi.setActiveTools !== 'function') return false;
    const previous = this.pi.getActiveTools();
    const result = reconcileGoalTools(this.pi, goal);
    const required = goal.status === 'budget_limited' ? [COMPLETE_TOOL] : [COMPLETE_TOOL, BLOCKED_TOOL];
    const available = required.every((name) => result.activeTools.includes(name));
    if (!available) {
      this.pi.setActiveTools(previous);
      return false;
    }
    this.executionGeneration += 1;
    this.lastToolCallGoalId = undefined;
    this.lastToolCallGeneration = undefined;
    return true;
  }

  private deactivateTools(): void {
    if (typeof this.pi.getActiveTools === 'function' && typeof this.pi.setActiveTools === 'function') {
      removeGoalTools(this.pi);
    }
    this.executionGeneration += 1;
    this.lastToolCallGoalId = undefined;
    this.lastToolCallGeneration = undefined;
  }

  private fenceExecution(): void {
    this.executionGeneration += 1;
    this.runGoalId = undefined;
    this.runOrigin = undefined;
    this.runExecutionGeneration = undefined;
    this.runToolAttempted = false;
    this.lastToolCallGoalId = undefined;
    this.lastToolCallGeneration = undefined;
    this.compactState = undefined;
    this.budgetWrapUpGoalId = undefined;
  }

  private noteToolCall(toolName: string): void {
    if (toolName !== COMPLETE_TOOL && toolName !== BLOCKED_TOOL) return;
    this.runToolAttempted = true;
    const goal = this.runtime.snapshot().goal;
    if (!goal) return;
    this.lastToolCallGoalId = goal.id;
    this.lastToolCallGeneration = this.executionGeneration;
  }

  private pauseForToolPolicyDrift(ctx: ExtensionContext, goal: ActiveGoal): void {
    if (!this.isCurrent(ctx) || this.runtime.snapshot().goal?.id !== goal.id || goal.status !== 'active') return;
    updateGoalUsage(goal, ctx, Date.now(), false);
    this.fenceExecution();
    const paused = transitionGoal({ ...goal }, 'paused');
    this.runtime.replaceState({ goal: paused, queue: [...this.runtime.snapshot().queue] });
    this.deactivateTools();
    this.abortCurrentTurn(ctx);
    this.refreshStatus();
    this.emitState('required Goal tool unavailable');
    this.notify(
      'Goal tools are unavailable, so the Goal was paused. Restore the tools and run /goal resume.',
      'warning',
    );
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
    this.runGoalId = undefined;
    this.runOrigin = undefined;
    this.runExecutionGeneration = undefined;
    this.lastToolCallGoalId = undefined;
    this.lastToolCallGeneration = undefined;
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
    if (!compact.willRetry && compact.hadAutomaticRun && event.willRetry !== true) {
      this.pendingRunOrigin = 'automatic';
      this.runGoalId = goal.id;
      this.runOrigin = 'automatic';
      this.runExecutionGeneration = this.executionGeneration;
    }
  }

  private refreshStatus(): void {
    const ctx = this.context;
    const snapshot = this.runtime.snapshot();
    if (!ctx?.hasUI) return;
    const queueWaiting = snapshot.pendingAction !== undefined || (!snapshot.goal && snapshot.queue.length > 0);
    ctx.ui.setStatus(STATUS_KEY, queueWaiting ? 'queued' : formatStatus(snapshot.goal));
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
    const parsed = parseGoalCommand(args, { experimentalGoals: this.settings.experimental.goals });
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
      case 'add':
        await this.addGoal(parsed.objective ?? '', parsed.tokenBudget, ctx);
        return;
      case 'prioritize':
        await this.prioritizeGoal(parsed.objective ?? '', parsed.tokenBudget, ctx);
        return;
      case 'drop-last':
        this.dropLastGoal(ctx);
        return;
      case 'skip':
        await this.skipGoal(ctx);
        return;
    }
  }

  private showStatus(): void {
    const snapshot = this.runtime.snapshot();
    const goal = snapshot.goal;
    if (!goal) {
      this.notify('No active goal.', 'info');
      return;
    }
    const queue = snapshot.queue.length ? `\nQueued: ${snapshot.queue.map((item) => item.text).join(', ')}` : '';
    this.notify(`Goal: ${goal.text}\nStatus: ${goal.status}${queue}`, 'info');
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
      if (!(await this.archiveAll([oldGoal, ...previous.queue], 'replaced'))) {
        this.notify('Goal replacement aborted because history archival failed.', 'error');
        return;
      }
    }
    const next = createGoal(objective, budget, { id: goalId, baselineTokens: currentTokenTotal(ctx) });
    if (!this.activateTools(next)) {
      this.notify('Cannot start /goal: host policy rejected Goal tools.', 'error');
      return;
    }
    this.runtime.replaceState({ goal: next, queue: [] });
    this.budgetWrapUpGoalId = undefined;
    this.pendingRunOrigin = 'manual';
    this.refreshStatus();
    this.emitState();
    try {
      this.pi.sendUserMessage(buildGoalPrompt(next), { deliverAs: 'followUp' });
    } catch (error) {
      this.runtime.replaceState({ goal: oldGoal, queue: previous.queue });
      this.fenceExecution();
      if (!oldGoal) this.deactivateTools();
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
    this.runtime.replaceState({ goal: next, queue: [...this.runtime.snapshot().queue] });
    this.deactivateTools();
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
    void ctx;
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      this.notify('Goal token budget is still reached.', 'warning');
      return;
    }
    const next = resetGoalSafetyEpoch(transitionGoal({ ...goal, updatedAt: Date.now() }, 'active'));
    if (!this.activateTools(next)) {
      this.notify('Cannot resume /goal: host policy rejected Goal tools.', 'error');
      return;
    }
    this.runtime.replaceState({ goal: next, queue: [...this.runtime.snapshot().queue] });
    this.budgetWrapUpGoalId = undefined;
    this.pendingRunOrigin = 'manual';
    this.refreshStatus();
    this.emitState();
    try {
      this.pi.sendUserMessage(buildResumePrompt(next, goal.status), { deliverAs: 'followUp' });
    } catch (error) {
      this.fenceExecution();
      this.runtime.replaceState({ goal, queue: [...this.runtime.snapshot().queue] });
      this.deactivateTools();
      this.refreshStatus();
      this.notify(`Goal resume failed: ${errorText(error)}`, 'error');
    }
  }

  private async clearGoal(ctx: ExtensionContext): Promise<void> {
    const snapshot = this.runtime.snapshot();
    if (!(await this.archiveAll([...(snapshot.goal ? [snapshot.goal] : []), ...snapshot.queue], 'cleared'))) {
      this.notify('Goal clear aborted because history archival failed.', 'error');
      return;
    }
    this.fenceExecution();
    this.runtime.clear();
    this.deactivateTools();
    ctx.abort();
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
    const next = {
      ...goal,
      text: objective,
      ...(budget === undefined ? {} : { tokenBudget: budget }),
      updatedAt: Date.now(),
    };
    this.runtime.replaceState({ goal: next, queue: [...this.runtime.snapshot().queue] });
    this.refreshStatus();
    this.emitState();
    if (goal.status === 'active') this.pi.sendUserMessage(buildObjectiveUpdatedPrompt(next), { deliverAs: 'followUp' });
    else this.notify(`Goal updated but remains ${goal.status}. Resume explicitly to execute it.`);
    void ctx;
  }

  private async addGoal(objective: string, budget: number | undefined, _ctx: ExtensionContext): Promise<void> {
    const validation = validateObjective(objective);
    if (validation) {
      this.notify(validation, 'warning');
      return;
    }
    const snapshot = this.runtime.snapshot();
    if (!snapshot.goal) {
      await this.startGoal(objective, budget, this.context as ExtensionCommandContext);
      return;
    }
    const state = enqueueGoal(
      {
        goal: snapshot.goal,
        queue: [...snapshot.queue],
        pendingAction: snapshot.pendingAction,
        enabled: this.settings.experimental.goals,
      },
      objective,
      budget,
    );
    this.runtime.replaceState(state);
    this.refreshStatus();
    this.emitState();
    this.notify(`Goal added at position ${state.queue.length + 1}: ${objective}`);
  }

  private async prioritizeGoal(objective: string, budget: number | undefined, _ctx: ExtensionContext): Promise<void> {
    const validation = validateObjective(objective);
    if (validation) {
      this.notify(validation, 'warning');
      return;
    }
    const snapshot = this.runtime.snapshot();
    if (!snapshot.goal) {
      await this.startGoal(objective, budget, this.context as ExtensionCommandContext);
      return;
    }
    this.runtime.replaceState({
      goal: snapshot.goal,
      queue: [...snapshot.queue],
      pendingAction: { kind: 'prioritize', objective, tokenBudget: budget },
    });
    this.notify(`Priority goal queued until the current turn settles: ${objective}`);
  }

  private dropLastGoal(_ctx: ExtensionContext): void {
    const snapshot = this.runtime.snapshot();
    if (!snapshot.queue.length) {
      this.notify('No queued goals.', 'info');
      return;
    }
    this.runtime.replaceState({
      goal: snapshot.goal,
      queue: [...snapshot.queue].slice(0, -1),
      pendingAction: snapshot.pendingAction,
    });
    this.notify('Last queued goal dropped.', 'warning');
  }

  private async skipGoal(ctx: ExtensionContext): Promise<void> {
    const snapshot = this.runtime.snapshot();
    if (!snapshot.goal) {
      this.notify('No goals to skip.', 'info');
      return;
    }
    if (!(await this.archive(snapshot.goal, 'skipped'))) {
      this.notify('Goal skip aborted because history archival failed.', 'error');
      return;
    }
    this.fenceExecution();
    const nextState = skipCurrentGoal({
      goal: snapshot.goal,
      queue: [...snapshot.queue],
      pendingAction: snapshot.pendingAction,
      enabled: this.settings.experimental.goals,
    });
    if (nextState.pendingAction) this.runtime.replaceState(nextState);
    else this.runtime.clear();
    this.deactivateTools();
    ctx.abort();
    this.refreshStatus();
    this.emitState('skipped');
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
    const failure = classifyAgentFailure(messages);
    updateGoalUsage(goal, ctx, Date.now(), true);
    if (failure === 'aborted') {
      // User-initiated aborts and safety aborts are fenced without inventing a
      // provider failure. A later explicit resume establishes a new execution lease.
      this.fenceExecution();
      this.runtime.replaceState({ goal, queue: [...snapshot.queue] });
      this.refreshStatus();
      return;
    }
    if (failure === 'usage_limited' || failure === 'blocked') {
      this.fenceExecution();
      const stopped = transitionGoal({ ...goal }, failure);
      this.runtime.replaceState({ goal: stopped, queue: [...snapshot.queue] });
      this.deactivateTools();
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
      const cause = safetyLimitReached(goal, this.settings.continuationLimits);
      if (cause) {
        this.pauseForSafety(ctx, goal, cause);
        return;
      }
    }

    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      this.limitForBudget(ctx, goal, snapshot.queue);
      return;
    }
    this.runtime.replaceState({ goal, queue: [...snapshot.queue] });
    this.refreshStatus();
  }

  private async dispatchPendingQueueAction(ctx: ExtensionContext): Promise<boolean> {
    if (!this.isCurrent(ctx)) return false;
    const snapshot = this.runtime.snapshot();
    const pending = snapshot.pendingAction;
    if (!pending) return false;
    if (!this.settings.experimental.goals || !ctx.isIdle() || ctx.hasPendingMessages()) return true;

    if (pending.kind === 'prioritize') {
      const current = snapshot.goal;
      if (!current) {
        this.runtime.replaceState({ queue: [...snapshot.queue] });
        await this.startGoal(pending.objective, pending.tokenBudget, ctx as ExtensionCommandContext);
        return true;
      }
      if (current.status === 'active') updateGoalUsage(current, ctx, Date.now(), false);
      const prioritized = createGoal(pending.objective, pending.tokenBudget, {
        baselineTokens: currentTokenTotal(ctx),
      });
      const displacedQueue =
        current.status === 'complete'
          ? [...snapshot.queue]
          : [transitionGoal({ ...current, activeStartedAt: undefined }, 'queued'), ...snapshot.queue];
      this.deactivateTools();
      if (!this.activateTools(prioritized)) {
        const paused = transitionGoal(prioritized, 'paused');
        this.runtime.replaceState({ goal: paused, queue: displacedQueue });
        this.deactivateTools();
        this.refreshStatus();
        this.emitState('queued goal tools unavailable');
        this.notify('Priority Goal is retained but paused because host policy rejected Goal tools.', 'warning');
        return true;
      }
      this.runtime.replaceState({ goal: prioritized, queue: displacedQueue });
      this.pendingRunOrigin = 'manual';
      this.refreshStatus();
      this.emitState('prioritized');
      try {
        this.pi.sendUserMessage(buildGoalPrompt(prioritized), { deliverAs: 'followUp' });
      } catch (error) {
        this.pauseForDeliveryFailure(ctx, prioritized, `Priority Goal kickoff failed: ${errorText(error)}`);
      }
      return true;
    }

    const current = snapshot.goal;
    if (!current || current.id !== pending.goalId || (pending.reason === 'complete' && current.status !== 'complete')) {
      this.runtime.replaceState({ goal: current, queue: [...snapshot.queue] });
      this.refreshStatus();
      return true;
    }
    const promoted = promoteNextGoal(
      { goal: current, queue: [...snapshot.queue], pendingAction: pending, enabled: true },
      Date.now(),
      currentTokenTotal(ctx),
    );
    const next = promoted.goal;
    if (!next || next.id === current.id) {
      this.runtime.clear();
      this.deactivateTools();
      this.refreshStatus();
      this.emitState(pending.reason);
      return true;
    }
    if (!this.activateTools(next)) {
      const paused = transitionGoal(next, 'paused');
      this.runtime.replaceState({ goal: paused, queue: [...promoted.queue] });
      this.deactivateTools();
      this.refreshStatus();
      this.emitState('queued goal tools unavailable');
      this.notify('Next Goal is retained but paused because host policy rejected Goal tools.', 'warning');
      return true;
    }
    this.runtime.replaceState({ goal: next, queue: [...promoted.queue] });
    this.pendingRunOrigin = 'manual';
    this.refreshStatus();
    this.emitState(pending.reason);
    try {
      this.pi.sendUserMessage(buildGoalPrompt(next), { deliverAs: 'followUp' });
    } catch (error) {
      this.pauseForDeliveryFailure(ctx, next, `Queued Goal kickoff failed: ${errorText(error)}`);
    }
    return true;
  }

  private async continueAfterSettled(ctx: ExtensionContext): Promise<void> {
    if (!this.isCurrent(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const snapshot = this.runtime.snapshot();
    const goal = snapshot.goal;
    if (!goal || goal.status !== 'active' || !this.runGoalId || this.runGoalId !== goal.id) return;
    if (this.runExecutionGeneration !== this.executionGeneration) {
      this.fenceExecution();
      return;
    }
    if (!canExecuteGoalTools(this.pi, goal)) {
      this.pauseForToolPolicyDrift(ctx, goal);
      return;
    }
    const cause = safetyLimitReached(goal, this.settings.continuationLimits);
    if (cause) {
      this.pauseForSafety(ctx, goal, cause);
      return;
    }
    const next = incrementGoal({ ...goal });
    this.runtime.replaceState({ goal: next, queue: [...snapshot.queue] });
    const continuation = buildContinuePrompt(next);
    this.pendingRunOrigin = 'automatic';
    try {
      this.pi.sendUserMessage(continuation, { deliverAs: 'followUp' });
    } catch (error) {
      this.pauseForDeliveryFailure(ctx, next, `Goal continuation failed: ${errorText(error)}`);
      return;
    }
    this.runGoalId = undefined;
    this.runOrigin = undefined;
    this.runExecutionGeneration = undefined;
    this.runToolAttempted = false;
  }

  private pauseForSafety(ctx: ExtensionContext, goal: ActiveGoal, cause: 'continuation_limit' | 'no_progress'): void {
    if (this.runtime.snapshot().goal?.id !== goal.id) return;
    this.fenceExecution();
    const paused = transitionGoal({ ...goal, safetyPauseCause: cause }, 'paused');
    this.runtime.replaceState({ goal: paused, queue: [...this.runtime.snapshot().queue] });
    this.deactivateTools();
    this.abortCurrentTurn(ctx);
    this.refreshStatus();
    this.emitState(cause === 'continuation_limit' ? 'automatic response limit' : 'no progress');
    const detail = cause === 'continuation_limit' ? 'automatic response limit' : 'no progress';
    this.notify(`Goal paused by safety limit: ${detail}. Run /goal resume to continue.`, 'warning');
  }

  private limitForBudget(ctx: ExtensionContext, goal: ActiveGoal, queue: readonly ActiveGoal[]): void {
    this.fenceExecution();
    const limited = transitionGoal({ ...goal }, 'budget_limited');
    this.runtime.replaceState({ goal: limited, queue: [...queue] });
    this.deactivateTools();
    const canWrap = this.activateTools(limited);
    if (canWrap && this.budgetWrapUpGoalId !== limited.id) {
      this.budgetWrapUpGoalId = limited.id;
      try {
        this.pi.sendMessage(
          {
            customType: 'goal-budget-wrap-up',
            content:
              'The Goal token budget is exhausted. Stop substantive work, summarize verified progress and blockers, and call goal_complete only if every requirement is already proven.',
            display: true,
            details: { goalId: limited.id },
          },
          { deliverAs: 'steer' },
        );
      } catch (error) {
        this.budgetWrapUpGoalId = undefined;
        this.notify(`Goal budget wrap-up failed: ${errorText(error)}`, 'error');
      }
    }
    if (!canWrap) this.notify('Goal budget reached, but host policy rejected goal_complete.', 'warning');
    this.abortCurrentTurn(ctx);
    this.refreshStatus();
    this.emitState('token budget reached');
  }

  private pauseForDeliveryFailure(ctx: ExtensionContext, goal: ActiveGoal, message: string): void {
    this.fenceExecution();
    const paused = transitionGoal({ ...goal }, 'paused');
    this.runtime.replaceState({ goal: paused, queue: [...this.runtime.snapshot().queue] });
    this.deactivateTools();
    this.abortCurrentTurn(ctx);
    this.refreshStatus();
    this.emitState('delivery failed');
    this.notify(message, 'error');
  }

  private async complete(params: CompleteInput, ctx: ExtensionContext): Promise<ToolResult> {
    const snapshot = this.runtime.snapshot();
    const goal = snapshot.goal;
    if (!goal || !this.acceptsToolCall(ctx, goal))
      return messageResult('Goal completion rejected because this tool call belongs to a stale Goal execution.', true);
    const validation = validateCompletionInput(goal, params as { goal_id?: string; summary?: string });
    if (!goal || (goal.status !== 'active' && goal.status !== 'budget_limited'))
      return messageResult('Goal completion is not available in the current state.', true);
    if (!validation.ok) return messageResult(validation.reason ?? 'Goal completion rejected.', true);
    const summary = typeof params.summary === 'string' ? params.summary.trim() : '';
    if (isContradictoryCompletionSummary(summary))
      return messageResult('Completion evidence contradicts completion.', true);
    if (!(await this.archive(goal, 'complete', summary)))
      return messageResult('Completion aborted because history archival failed.', true);
    this.fenceExecution();
    const completed = transitionGoal({ ...goal }, 'complete');
    if (snapshot.queue.length && this.settings.experimental.goals) {
      this.runtime.replaceState({
        goal: completed,
        queue: [...snapshot.queue],
        pendingAction: { kind: 'advance', goalId: goal.id, reason: 'complete', completedText: goal.text },
      });
    } else {
      this.runtime.clear();
    }
    this.deactivateTools();
    ctx.abort();
    this.refreshStatus();
    this.emitState(undefined, summary);
    return messageResult(`Goal complete: ${goal.text}`);
  }

  private async blocked(params: BlockedInput, ctx: ExtensionContext): Promise<ToolResult> {
    const snapshot = this.runtime.snapshot();
    const goal = snapshot.goal;
    if (!goal || !this.acceptsToolCall(ctx, goal))
      return messageResult('Goal blocker rejected because this tool call belongs to a stale Goal execution.', true);
    const validation = validateBlockedInput(
      goal,
      params as { goal_id?: string; reason?: string; evidence?: string; repeated_turns?: number },
    );
    if (!goal || goal.status !== 'active')
      return messageResult('Goal blocking is not available in the current state.', true);
    if (!validation.ok) return messageResult(validation.reason ?? 'Goal blocker rejected.', true);
    const reason = typeof params.reason === 'string' ? params.reason.trim() : 'blocked';
    this.fenceExecution();
    const blocked = transitionGoal({ ...goal }, 'blocked');
    this.runtime.replaceState({ goal: blocked, queue: [...snapshot.queue] });
    this.deactivateTools();
    ctx.abort();
    this.refreshStatus();
    this.emitState(reason);
    return messageResult(`Goal blocked: ${reason}`);
  }

  private acceptsToolCall(ctx: ExtensionContext, goal: ActiveGoal): boolean {
    if (!this.isCurrent(ctx)) return false;
    if (this.runGoalId && (this.runGoalId !== goal.id || this.runExecutionGeneration !== this.executionGeneration))
      return false;
    if (
      this.lastToolCallGoalId &&
      (this.lastToolCallGoalId !== goal.id || this.lastToolCallGeneration !== this.executionGeneration)
    )
      return false;
    return canExecuteGoalTools(this.pi, goal);
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
    if (!this.history) return true;
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

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.stateListeners.clear();
    this.deactivateTools();
    this.context = undefined;
  }
}

function classifyAgentFailure(messages: readonly unknown[]): 'usage_limited' | 'blocked' | 'aborted' | undefined {
  const assistant = [...messages].reverse().find((message) => isAssistantMessage(message));
  if (!assistant || typeof assistant !== 'object') return undefined;
  const candidate = assistant as { stopReason?: unknown; errorMessage?: unknown; content?: unknown; text?: unknown };
  if (candidate.stopReason === 'aborted') return 'aborted';
  if (candidate.stopReason !== 'error' && candidate.stopReason !== 'length' && candidate.errorMessage === undefined)
    return undefined;
  const details = [candidate.errorMessage, extractMessageText(candidate)]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (
    candidate.stopReason === 'length' ||
    /(?:rate|quota|usage|token|context|capacity|limit|429|too many|billing|exhaust)/u.test(details)
  )
    return 'usage_limited';
  return 'blocked';
}

function isAssistantMessage(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { role?: unknown }).role === 'assistant');
}

function extractMessageText(value: { content?: unknown; text?: unknown }): string {
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content)) return '';
  return value.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join(' ');
}
