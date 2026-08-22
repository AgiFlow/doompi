import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { activateGoalExtension } from '../../src/adapters/pi/runtimeActivation.ts';
import type { GoalHistoryPort } from '../../src/types/history.ts';

interface HandlerRecord {
  event: string;
  handler: (event: never, context: ExtensionContext) => unknown;
}

function createFixture(options: { autoActivateRegisteredTools?: boolean } = {}) {
  const handlers: HandlerRecord[] = [];
  const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
  const tools: ToolDefinition[] = [];
  let activeTools = ['read'];
  const appendEntry = vi.fn();
  const sendUserMessage = vi.fn();
  const abort = vi.fn();
  const context = {
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      onTerminalInput: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(() => ''),
    },
    mode: 'tui',
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => 'manager-session',
      getBranch: () => [],
      getEntries: () => [],
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort,
  } as unknown as ExtensionContext;
  const history: GoalHistoryPort = {
    list: async () => [],
    archive: async (entry) => entry,
    remove: async () => undefined,
    restart: async (id) => ({ historyId: id, goalId: 'new', objective: 'restart' }),
  };
  const pi = {
    on(event: string, handler: (event: never, context: ExtensionContext) => unknown) {
      handlers.push({ event, handler });
    },
    registerCommand(name: string, definition: { handler: (args: string, context: ExtensionContext) => Promise<void> }) {
      commands.set(name, definition);
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
      if (options.autoActivateRegisteredTools) activeTools = [...new Set([...activeTools, tool.name])];
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    appendEntry,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  return {
    pi,
    context,
    handlers,
    commands,
    tools,
    appendEntry,
    sendUserMessage,
    activeTools: () => activeTools,
    history,
  };
}

async function dispatch(fixture: ReturnType<typeof createFixture>, event: string): Promise<void> {
  await dispatchEvent(fixture, event, {});
}

async function dispatchEvent(
  fixture: ReturnType<typeof createFixture>,
  event: string,
  payload: unknown,
): Promise<void> {
  for (const item of fixture.handlers.filter((candidate) => candidate.event === event)) {
    await item.handler(payload as never, fixture.context);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

describe('Goal Pi manager activation', () => {
  it('keeps a fresh session dormant and activates only after an objective is accepted', async () => {
    const fixture = createFixture({ autoActivateRegisteredTools: true });
    const dispose = activateGoalExtension(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });

    expect(fixture.activeTools()).toEqual(['read', 'goal_complete', 'goal_blocked']);
    await dispatch(fixture, 'session_start');
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.context.ui.setStatus).not.toHaveBeenCalledWith('goal', expect.any(String));

    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    expect(fixture.activeTools()).toEqual(['read', 'goal_complete', 'goal_blocked']);
    expect(fixture.appendEntry).toHaveBeenCalledWith(
      'goal-state',
      expect.objectContaining({ goal: expect.objectContaining({ text: 'ship it', status: 'active' }) }),
    );
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    expect(fixture.sendUserMessage).toHaveBeenLastCalledWith('[goal]\nship it', { deliverAs: 'followUp' });

    const beforeStart = fixture.handlers.find((candidate) => candidate.event === 'before_agent_start');
    const result = (await beforeStart?.handler({ systemPrompt: 'base' } as never, fixture.context)) as
      | { systemPrompt?: string }
      | undefined;
    expect(result?.systemPrompt).toContain('<goal_objective>');
    expect(result?.systemPrompt).toContain('ship it');
    expect(result?.systemPrompt).toContain('Goal-mode rules:');

    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial work' }], stopReason: 'stop' }],
    });
    await dispatch(fixture, 'agent_settled');
    await vi.waitFor(() => expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2));
    expect(fixture.sendUserMessage).toHaveBeenLastCalledWith('[goal]\nContinue.', { deliverAs: 'followUp' });
    dispose();
  });

  it('rejects stale completion ids and fully deactivates only after valid completion', async () => {
    const fixture = createFixture();
    const archive = vi.spyOn(fixture.history, 'archive');
    activateGoalExtension(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    const tool = fixture.tools.find((candidate) => candidate.name === 'goal_complete');
    expect(tool).toBeDefined();
    const execute = tool?.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      update: undefined,
      context: ExtensionContext,
    ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    const stale = await execute('call-1', { goal_id: 'stale', summary: 'done' }, undefined, undefined, fixture.context);
    expect(stale.details.error).toBe(true);
    const entry = fixture.appendEntry.mock.calls.at(-1)?.[1] as { goal?: { id?: string } } | undefined;
    const goalId = entry?.goal?.id;
    expect(goalId).toBeTypeOf('string');
    const completed = await execute(
      'call-2',
      { goal_id: goalId, summary: 'all requirements are verified' },
      undefined,
      undefined,
      fixture.context,
    );
    expect(completed.details.error).toBe(false);
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.context.ui.setStatus).toHaveBeenLastCalledWith('goal', undefined);
    expect(fixture.context.abort).toHaveBeenCalled();

    const beforeStart = fixture.handlers.find((candidate) => candidate.event === 'before_agent_start');
    const promptAfterCompletion = await beforeStart?.handler({ systemPrompt: 'base' } as never, fixture.context);
    expect(promptAfterCompletion).toBeUndefined();
  });
});

describe('Goal Doom leader operations', () => {
  it('seeds exactly /goal and preserves a cancelled draft', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await activation.manager.startFromLeader(fixture.context);
    expect(fixture.context.ui.setEditorText).toHaveBeenCalledWith('/goal ');

    (fixture.context.ui.getEditorText as unknown as ReturnType<typeof vi.fn>).mockReturnValue('keep this draft');
    (fixture.context.ui.confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await activation.manager.startFromLeader(fixture.context);
    expect(fixture.context.ui.setEditorText).toHaveBeenCalledTimes(1);
    activation.dispose();
  });

  it('shows the current goal without changing the editor', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    (fixture.context.ui.notify as unknown as ReturnType<typeof vi.fn>).mockClear();

    await activation.manager.showFromLeader(fixture.context);

    expect(fixture.context.ui.notify).toHaveBeenCalledWith('Goal: ship it\nStatus: active', 'info');
    expect(fixture.context.ui.setEditorText).not.toHaveBeenCalled();
    activation.dispose();
  });

  it('archives before end and never turns end into pause', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    const archive = vi.spyOn(fixture.history, 'archive');
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    await activation.manager.endFromLeader(fixture.context);
    expect(archive).toHaveBeenCalledOnce();
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.context.ui.setStatus).toHaveBeenLastCalledWith('goal', undefined);
    activation.dispose();
  });
});

describe('Goal lifecycle safety and fencing', () => {
  function safetySettings(automaticTurns: number | null, noProgressTurns: number | null) {
    return {
      toolVisibility: 'operational' as const,
      experimental: { goals: false },
      continuationLimits: { automaticTurns, noProgressTurns },
    };
  }

  function configureSettings(manager: unknown, settings: ReturnType<typeof safetySettings>): void {
    (manager as { settings: typeof settings }).settings = settings;
  }

  it('pauses and fences an automatic run at the automatic response limit', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    configureSettings(activation.manager, safetySettings(1, null));
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'kickoff' }], stopReason: 'stop' }],
    });
    await dispatchEvent(fixture, 'agent_settled', {});
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'progress' }], stopReason: 'stop' }],
    });

    expect(activation.manager.snapshot().goal).toMatchObject({
      status: 'paused',
      safetyPauseCause: 'continuation_limit',
    });
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.context.abort).toHaveBeenCalled();
    activation.dispose();
  });

  it('pauses repeated tool-free output at the no-progress limit', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    configureSettings(activation.manager, safetySettings(null, 1));
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'kickoff' }], stopReason: 'stop' }],
    });
    await dispatchEvent(fixture, 'agent_settled', {});
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'same answer' }], stopReason: 'stop' }],
    });

    expect(activation.manager.snapshot().goal).toMatchObject({
      status: 'paused',
      safetyPauseCause: 'no_progress',
      toolFreeRepeatCount: 1,
    });
    expect(fixture.activeTools()).toEqual(['read']);
    activation.dispose();
  });

  it('retains a usage-limited state for provider quota failures', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'provider stopped' }],
          stopReason: 'error',
          errorMessage: 'rate limit exceeded',
        },
      ],
    });

    expect(activation.manager.snapshot().goal?.status).toBe('usage_limited');
    expect(fixture.activeTools()).toEqual(['read']);
    activation.dispose();
  });

  it('classifies non-quota provider failures as blocked', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'provider stopped' }],
          stopReason: 'error',
          errorMessage: 'transport closed',
        },
      ],
    });

    expect(activation.manager.snapshot().goal?.status).toBe('blocked');
    expect(fixture.activeTools()).toEqual(['read']);
    activation.dispose();
  });

  it('fences owned continuation work across compaction and avoids duplicate overflow delivery', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'session_before_compact', { reason: 'overflow', willRetry: true });
    await dispatchEvent(fixture, 'session_compact', { reason: 'overflow', willRetry: true });
    await dispatchEvent(fixture, 'agent_settled', {});

    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(activation.manager.snapshot().goal?.status).toBe('active');
    activation.dispose();
  });

  it('pauses instead of injecting a prompt after external tool-policy drift', async () => {
    const fixture = createFixture();
    const activation = (await import('../../src/adapters/pi/runtimeActivation.ts')).activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    fixture.pi.setActiveTools?.(['read']);
    const beforeStart = fixture.handlers.find((candidate) => candidate.event === 'before_agent_start');
    const result = (await beforeStart?.handler({ systemPrompt: 'base' } as never, fixture.context)) as
      | { systemPrompt?: string }
      | undefined;

    expect(result).toBeUndefined();
    expect(activation.manager.snapshot().goal?.status).toBe('paused');
    expect(fixture.activeTools()).toEqual(['read']);
    activation.dispose();
  });
});

describe('Goal manager command, restore, and queue branches', () => {
  async function activate(fixture: ReturnType<typeof createFixture>) {
    const runtime = await import('../../src/adapters/pi/runtimeActivation.ts');
    const activation = runtime.activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return activation;
  }

  function setExperimental(manager: unknown): void {
    (manager as { settings: { experimental: { goals: boolean } } }).settings.experimental.goals = true;
  }

  it('handles status, pause, resume, clear, and invalid command paths without a goal', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('', fixture.context);
    await fixture.commands.get('goal')?.handler('pause', fixture.context);
    await fixture.commands.get('goal')?.handler('resume', fixture.context);
    await fixture.commands.get('goal')?.handler('clear', fixture.context);
    await fixture.commands.get('goal')?.handler('edit revised', fixture.context);
    expect(fixture.context.ui.notify).toHaveBeenCalledWith('No active goal.', 'info');
    expect(fixture.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining('No active goal'), 'info');
    activation.dispose();
  });

  it('rejects invalid objectives and restrictive tool policies atomically', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('', fixture.context);
    const pi = fixture.pi as unknown as { setActiveTools: (names: string[]) => void };
    pi.setActiveTools(['read']);
    pi.setActiveTools = () => undefined;
    await fixture.commands.get('goal')?.handler('cannot start', fixture.context);
    expect(activation.manager.snapshot().goal).toBeUndefined();
    expect(fixture.activeTools()).toEqual(['read']);
    activation.dispose();
  });

  it('rolls back kickoff failure and respects replacement cancellation', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    fixture.sendUserMessage.mockImplementation(() => {
      throw new Error('kickoff failed');
    });
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    expect(activation.manager.snapshot().goal).toBeUndefined();
    fixture.sendUserMessage.mockImplementation(() => undefined);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    (fixture.context.ui.confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await fixture.commands.get('goal')?.handler('second', fixture.context);
    expect(activation.manager.snapshot().goal?.text).toBe('first');
    activation.dispose();
  });

  it('aborts replacement and clear when history archival fails', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    vi.spyOn(fixture.history, 'archive').mockRejectedValue(new Error('history unavailable'));
    await fixture.commands.get('goal')?.handler('second', fixture.context);
    expect(activation.manager.snapshot().goal?.text).toBe('first');
    await activation.manager.endFromLeader(fixture.context);
    expect(activation.manager.snapshot().goal?.text).toBe('first');
    activation.dispose();
  });

  it('edits active and retained goals while preserving stopped execution', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    await fixture.commands.get('goal')?.handler('edit --tokens 2k revised', fixture.context);
    expect(activation.manager.snapshot().goal).toMatchObject({ text: 'revised', tokenBudget: 2000, status: 'active' });
    await fixture.commands.get('goal')?.handler('pause', fixture.context);
    await fixture.commands.get('goal')?.handler('edit stopped', fixture.context);
    expect(activation.manager.snapshot().goal).toMatchObject({ text: 'stopped', status: 'paused' });
    await fixture.commands.get('goal')?.handler('resume', fixture.context);
    expect(activation.manager.snapshot().goal?.status).toBe('active');
    activation.dispose();
  });

  it('supports experimental queue add, prioritize, drop, skip, and promotion', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    setExperimental(activation.manager);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    await fixture.commands.get('goal')?.handler('add second', fixture.context);
    await fixture.commands.get('goal')?.handler('prioritize urgent', fixture.context);
    expect(activation.manager.snapshot().pendingAction).toMatchObject({ kind: 'prioritize', objective: 'urgent' });
    await dispatch(fixture, 'agent_settled');
    await vi.waitFor(() => expect(activation.manager.snapshot().goal?.text).toBe('urgent'));
    expect(activation.manager.snapshot().queue.map((goal) => goal.text)).toEqual(['first', 'second']);
    await fixture.commands.get('goal')?.handler('drop-last', fixture.context);
    expect(activation.manager.snapshot().queue.map((goal) => goal.text)).toEqual(['first']);
    const queuedId = activation.manager.snapshot().queue[0]?.id;
    fixture.sendUserMessage.mockClear();
    await fixture.commands.get('goal')?.handler('skip', fixture.context);
    expect(activation.manager.snapshot()).toMatchObject({
      goal: { status: 'complete' },
      pendingAction: { kind: 'advance', reason: 'skip' },
    });
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    await dispatch(fixture, 'agent_settled');
    await vi.waitFor(() => expect(activation.manager.snapshot().goal?.text).toBe('first'));
    expect(activation.manager.snapshot().goal).toMatchObject({ status: 'active' });
    expect(activation.manager.snapshot().goal?.id).not.toBe(queuedId);
    activation.dispose();
  });

  it('limits budget and exposes only completion during wrap-up', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('--tokens 1 budget', fixture.context);
    const session = fixture.context.sessionManager as unknown as {
      getBranch: () => unknown[];
      getEntries: () => unknown[];
    };
    session.getBranch = () => [{ type: 'message', message: { role: 'assistant', usage: { totalTokens: 2 } } }];
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }],
    });
    expect(activation.manager.snapshot().goal?.status).toBe('budget_limited');
    expect(fixture.activeTools()).toEqual(['read', 'goal_complete']);
    activation.dispose();
  });

  it('rejects invalid tool payloads and blocks a valid active goal', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    const complete = fixture.tools.find((tool) => tool.name === 'goal_complete')?.execute as unknown as (
      ...args: unknown[]
    ) => Promise<{ details: { error: boolean } }>;
    const blocked = fixture.tools.find((tool) => tool.name === 'goal_blocked')?.execute as unknown as (
      ...args: unknown[]
    ) => Promise<{ details: { error: boolean } }>;
    await expect(
      complete('id', { goal_id: 'id', summary: '' }, undefined, undefined, fixture.context),
    ).resolves.toMatchObject({ details: { error: true } });
    const id = activation.manager.snapshot().goal?.id;
    expect(id).toBeDefined();
    await expect(
      blocked(
        'id',
        { goal_id: id, reason: 'external', evidence: 'same blocker', repeated_turns: 3 },
        undefined,
        undefined,
        fixture.context,
      ),
    ).resolves.toMatchObject({ details: { error: false } });
    expect(activation.manager.snapshot().goal?.status).toBe('blocked');
    activation.dispose();
  });

  it('restores an active goal without duplicate kickoff and keeps paused goals dormant', async () => {
    const fixture = createFixture();
    const { createGoal } = await import('../../src/services/stateMachine.ts');
    const { serializeGoalState } = await import('../../src/services/stateCodec.ts');
    const restored = createGoal('restored', undefined, { id: 'restored', now: 10 });
    const session = fixture.context.sessionManager as unknown as {
      getBranch: () => unknown[];
      getEntries: () => unknown[];
    };
    session.getBranch = () => [{ type: 'custom', customType: 'goal-state', data: serializeGoalState(restored) }];
    session.getEntries = session.getBranch;
    const runtime = await import('../../src/adapters/pi/runtimeActivation.ts');
    const activation = runtime.activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activation.manager.snapshot().goal?.text).toBe('restored');
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    fixture.sendUserMessage.mockClear();
    session.getBranch = () => [
      {
        type: 'custom',
        customType: 'goal-state',
        data: serializeGoalState({ ...restored, status: 'paused', activeStartedAt: undefined }),
      },
    ];
    session.getEntries = session.getBranch;
    await dispatch(fixture, 'session_start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.activeTools()).toEqual(['read']);
    activation.dispose();
  });

  it('supports history listing, restart, and removal failures without crashing', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const list = vi.fn(async () => [
      { id: 'history', objective: 'old', status: 'complete' as const, archivedAt: new Date().toISOString() },
    ]);
    fixture.history.list = list;
    const listed = await activation.manager.listHistory(fixture.context);
    expect(listed).toHaveLength(1);
    expect(list).toHaveBeenCalled();
    await activation.manager.restartFromHistory('history', fixture.context);
    expect(activation.manager.snapshot().goal?.text).toBe('restart');
    fixture.history.remove = vi.fn(async () => {
      throw new Error('remove failed');
    });
    await activation.manager.removeHistory('history', fixture.context);
    expect(fixture.context.ui.notify).toHaveBeenCalledWith(expect.stringContaining('removal failed'), 'error');
    activation.dispose();
  });

  it('handles non-TUI leader calls and duplicate disposal safely', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const nonTui = { ...fixture.context, mode: 'rpc', hasUI: false } as ExtensionContext;
    await activation.manager.startFromLeader(nonTui);
    expect(fixture.context.ui.setEditorText).not.toHaveBeenCalled();
    activation.dispose();
    activation.dispose();
  });
});

describe('Goal manager completion and archive branches', () => {
  async function activate(fixture: ReturnType<typeof createFixture>) {
    const runtime = await import('../../src/adapters/pi/runtimeActivation.ts');
    const activation = runtime.activateGoalRuntime(fixture.pi, {
      service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
      history: fixture.history,
    });
    await dispatch(fixture, 'session_start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return activation;
  }

  async function completeCurrent(fixture: ReturnType<typeof createFixture>, id: string): Promise<void> {
    const tool = fixture.tools.find((candidate) => candidate.name === 'goal_complete')?.execute as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await tool(
      'call',
      { goal_id: id, summary: 'all requirements are verified' },
      undefined,
      undefined,
      fixture.context,
    );
  }

  it('promotes a queued goal after completion and sends one kickoff', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    (activation.manager as unknown as { settings: { experimental: { goals: boolean } } }).settings.experimental.goals =
      true;
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    await fixture.commands.get('goal')?.handler('add second', fixture.context);
    const id = activation.manager.snapshot().goal?.id;
    expect(id).toBeDefined();
    fixture.sendUserMessage.mockClear();
    const queuedId = activation.manager.snapshot().queue[0]?.id;
    await completeCurrent(fixture, id as string);
    expect(activation.manager.snapshot()).toMatchObject({
      goal: { text: 'first', status: 'complete' },
      pendingAction: { kind: 'advance', reason: 'complete' },
    });
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    await dispatch(fixture, 'agent_settled');
    await vi.waitFor(() => expect(activation.manager.snapshot().goal?.text).toBe('second'));
    expect(activation.manager.snapshot().goal?.id).not.toBe(queuedId);
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    activation.dispose();
  });

  it('pauses a promoted queue goal when policy or kickoff delivery fails', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    (activation.manager as unknown as { settings: { experimental: { goals: boolean } } }).settings.experimental.goals =
      true;
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    await fixture.commands.get('goal')?.handler('add second', fixture.context);
    const firstId = activation.manager.snapshot().goal?.id;
    const pi = fixture.pi as unknown as { setActiveTools: (names: string[]) => void };
    const realSetter = pi.setActiveTools.bind(fixture.pi);
    realSetter(['read', 'goal_complete', 'goal_blocked']);
    pi.setActiveTools = (names) => {
      if (names.some((name) => name.startsWith('goal_'))) return;
      realSetter(names);
    };
    await completeCurrent(fixture, firstId as string);
    await dispatch(fixture, 'agent_settled');
    await vi.waitFor(() => expect(activation.manager.snapshot().goal?.status).toBe('paused'));
    activation.dispose();

    const secondFixture = createFixture();
    const secondActivation = await activate(secondFixture);
    (
      secondActivation.manager as unknown as { settings: { experimental: { goals: boolean } } }
    ).settings.experimental.goals = true;
    await secondFixture.commands.get('goal')?.handler('first', secondFixture.context);
    await secondFixture.commands.get('goal')?.handler('add second', secondFixture.context);
    const secondId = secondActivation.manager.snapshot().goal?.id;
    secondFixture.sendUserMessage.mockImplementationOnce(() => {
      throw new Error('queued delivery');
    });
    await completeCurrent(secondFixture, secondId as string);
    await dispatch(secondFixture, 'agent_settled');
    await vi.waitFor(() => expect(secondActivation.manager.snapshot().goal?.status).toBe('paused'));
    secondActivation.dispose();
  });

  it('rejects contradictory and stale completion calls', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    const complete = fixture.tools.find((tool) => tool.name === 'goal_complete')?.execute as unknown as (
      ...args: unknown[]
    ) => Promise<{ details: { error: boolean } }>;
    const id = activation.manager.snapshot().goal?.id;
    await expect(
      complete('call', { goal_id: id, summary: 'tests still fail' }, undefined, undefined, fixture.context),
    ).resolves.toMatchObject({ details: { error: true } });
    expect(activation.manager.snapshot().goal?.status).toBe('active');
    activation.dispose();
  });
});
