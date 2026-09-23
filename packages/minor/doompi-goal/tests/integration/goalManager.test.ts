import type { DoomBackgroundWorkService } from '@agimon-ai/doompi-core/backgroundWork';
import { createDoomToolSurface } from '@agimon-ai/doompi-core/toolSurface';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { createGoalRuntime } from '../../src/services/runtimeActivation';
import type { GoalHistoryPort } from '../../src/types/history';

interface HandlerRecord {
  event: string;
  handler: (event: never, context: ExtensionContext) => unknown;
}

type CheckRequest = {
  systemPrompt: string;
  messages: Array<{ content: string }>;
  tools: Array<{ name: string }>;
};
type CheckResponse = {
  content: Array<{ type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { totalTokens: number };
  stopReason: string;
  errorMessage?: string;
};
function verdict(request: CheckRequest, name = 'goal_continue', args: Record<string, unknown> = {}): CheckResponse {
  const goal = JSON.parse(request.messages[0]!.content) as { goal_id: string };
  return {
    content: [
      {
        type: 'toolCall',
        id: 'check-call',
        name,
        arguments: {
          goal_id: goal.goal_id,
          ...(name === 'goal_continue' ? { instruction: 'Run the remaining integration checks.' } : {}),
          ...args,
        },
      },
    ],
    usage: { totalTokens: 10 },
    stopReason: 'toolUse',
  };
}
function createFixture() {
  const handlers: HandlerRecord[] = [];
  const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
  const tools: ToolDefinition[] = [];
  const entries: Array<Record<string, unknown>> = [];
  let activeTools = ['read'];
  let idle = true;
  let pendingMessages = false;
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: 'custom', customType, data: structuredClone(data) });
  });
  const sendUserMessage = vi.fn();
  const check = vi.fn(async (request: CheckRequest, _signal: AbortSignal): Promise<CheckResponse> => verdict(request));
  const streamSimple = vi.fn((_model: unknown, request: CheckRequest, options: { signal: AbortSignal }) => ({
    result: () => check(request, options.signal),
  }));
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
    model: { provider: 'test', id: 'checker' },
    modelRegistry: { streamSimple },
    sessionManager: {
      getSessionId: () => 'manager-session',
      getBranch: () => entries,
      getEntries: () => entries,
    },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    abort: vi.fn(),
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
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    appendEntry,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const surface = createDoomToolSurface({
    generation: 'goal-test',
    allTools: () => ['read'],
    activeTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  });
  return {
    pi,
    surface,
    entries,
    check,
    streamSimple,
    activateRuntime() {
      const activation = createGoalRuntime(pi, {
        service: { execute: async () => ({ message: 'unused', level: 'info' as const }) },
        history,
      });
      for (const tool of activation.manager.tools()) pi.registerTool(tool);
      for (const command of activation.manager.commands()) pi.registerCommand(...command);
      for (const [event, handler] of Object.entries(activation.manager.events()))
        (pi.on as (event: string, handler: unknown) => void)(event, handler);
      const unbindBackground = activation.manager.bindBackgroundWork(createBackgroundWorkService().service);
      return {
        manager: activation.manager,
        unbindBackground,
        dispose: () => {
          unbindBackground();
          activation.dispose();
        },
      };
    },
    context,
    handlers,
    commands,
    tools,
    appendEntry,
    sendUserMessage,
    history,
    activeTools: () => activeTools,
    setIdle: (value: boolean) => {
      idle = value;
    },
    setPendingMessages: (value: boolean) => {
      pendingMessages = value;
    },
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
  if (event === 'agent_end') {
    for (const message of (payload as { messages?: unknown[] }).messages ?? [])
      fixture.entries.push({ type: 'message', message });
  }
  for (const item of fixture.handlers.filter((candidate) => candidate.event === event)) {
    await item.handler(payload as never, fixture.context);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

function createBackgroundWorkService(
  initialItems: Array<{ id: string; sessionId: string }> = [],
  initialErrors: Array<{ provider: string; message: string }> = [],
) {
  let items = initialItems;
  let errors = initialErrors;
  let snapshotError: Error | undefined;
  const service = {
    generation: `background-${crypto.randomUUID()}`,
    register: vi.fn(),
    snapshot: vi.fn((sessionId?: string) => {
      if (snapshotError) throw snapshotError;
      return {
        items: items
          .filter((item) => sessionId === undefined || item.sessionId === sessionId)
          .map((item) => ({ provider: 'test', ...item })),
        errors,
      };
    }),
  } as unknown as DoomBackgroundWorkService;
  return {
    service,
    setItems(next: Array<{ id: string; sessionId: string }>) {
      items = next;
    },
    setErrors(next: Array<{ provider: string; message: string }>) {
      errors = next;
    },
    setSnapshotError(error: Error | undefined) {
      snapshotError = error;
    },
  };
}

async function finishGoalTurn(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await dispatch(fixture, 'agent_start');
  await dispatchEvent(fixture, 'agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial work' }], stopReason: 'stop' }],
  });
}
describe('Goal Pi manager activation', () => {
  it('keeps a fresh session dormant and activates only after an objective is accepted', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();

    expect(fixture.activeTools()).toEqual(['read']);
    await dispatch(fixture, 'session_start');
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.context.ui.setStatus).not.toHaveBeenCalledWith('goal', expect.any(String));

    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.tools).toEqual([]);
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
    expect(fixture.sendUserMessage).toHaveBeenLastCalledWith('[goal]\nRun the remaining integration checks.', {
      deliverAs: 'followUp',
    });
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.check.mock.calls[0]?.[0].tools.map((tool) => tool.name)).toEqual([
      'goal_complete',
      'goal_continue',
      'goal_blocked',
    ]);
    activation.dispose();
  });

  it('archives and clears only a private checker completion with authoritative evidence', async () => {
    const fixture = createFixture();
    const archive = vi.spyOn(fixture.history, 'archive');
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    fixture.check.mockImplementationOnce(async (request) =>
      verdict(request, 'goal_complete', {
        summary: 'All requirements verified.',
        evidence: 'The integration test and build both passed.',
      }),
    );
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal).toBeUndefined();
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', reason: expect.stringContaining('Evidence:') }),
    );
    expect(fixture.tools).toEqual([]);
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    expect(fixture.context.ui.setStatus).toHaveBeenLastCalledWith('goal', undefined);
    expect(fixture.context.abort).not.toHaveBeenCalled();
    const hook = fixture.handlers.find((candidate) => candidate.event === 'before_agent_start');
    expect(await hook?.handler({ systemPrompt: 'base' } as never, fixture.context)).toBeUndefined();
    activation.dispose();
  });
});

describe('Goal Doom leader operations', () => {
  it('seeds exactly /goal and preserves a cancelled draft', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
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
    const activation = fixture.activateRuntime();
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
    const activation = fixture.activateRuntime();
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
      continuationLimits: { automaticTurns, noProgressTurns },
    };
  }

  function configureSettings(manager: unknown, settings: ReturnType<typeof safetySettings>): void {
    (manager as { settings: typeof settings }).settings = settings;
  }

  it('pauses and fences an automatic run at the automatic response limit', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
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
    await dispatch(fixture, 'agent_settled');
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
    const activation = fixture.activateRuntime();
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
    await dispatch(fixture, 'agent_settled');
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
    const activation = fixture.activateRuntime();
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
    const activation = fixture.activateRuntime();
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
    const activation = fixture.activateRuntime();
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

  it('does not require lifecycle tools on the main agent surface', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    const rival = fixture.surface.register({ source: 'rival', restrict: () => [] });
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal?.status).toBe('active');
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.tools).toEqual([]);
    expect(fixture.activeTools()).toEqual([]);
    rival.dispose();
    activation.dispose();
  });
});

describe('Goal background-work coordination', () => {
  async function activate(fixture: ReturnType<typeof createFixture>) {
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('ship it', fixture.context);
    return activation;
  }

  it('suppresses exact-session work and resumes from an authoritative change', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const background = createBackgroundWorkService([{ id: 'task-1', sessionId: 'manager-session' }]);
    activation.manager.bindBackgroundWork(background.service);
    await finishGoalTurn(fixture);

    await dispatch(fixture, 'agent_settled');
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(background.service.snapshot).toHaveBeenCalledWith('manager-session');

    background.setItems([]);
    activation.manager.backgroundWorkChanged(background.service);
    await vi.waitFor(() => expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2));
    expect(fixture.sendUserMessage).toHaveBeenLastCalledWith('[goal]\nRun the remaining integration checks.', {
      deliverAs: 'followUp',
    });
    activation.dispose();
  });

  it('ignores foreign-session work and coalesces duplicate readiness events', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const background = createBackgroundWorkService([{ id: 'task-foreign', sessionId: 'another-session' }]);
    activation.manager.bindBackgroundWork(background.service);
    await finishGoalTurn(fixture);

    activation.manager.backgroundWorkChanged(background.service);
    await dispatch(fixture, 'agent_settled');

    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(activation.manager.snapshot().goal?.iteration).toBe(1);
    activation.dispose();
  });

  it('fails closed for provider errors, snapshot failures, and service loss without consuming an iteration', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const background = createBackgroundWorkService([], [{ provider: 'task', message: 'unavailable' }]);
    const unbind = activation.manager.bindBackgroundWork(background.service);
    await finishGoalTurn(fixture);
    const iteration = activation.manager.snapshot().goal?.iteration;

    await dispatch(fixture, 'agent_settled');
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(activation.manager.snapshot().goal?.iteration).toBe(iteration);

    background.setErrors([]);
    background.setSnapshotError(new Error('snapshot failed'));
    activation.manager.backgroundWorkChanged(background.service);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(activation.manager.snapshot().goal?.iteration).toBe(iteration);

    background.setSnapshotError(undefined);
    unbind();
    await dispatch(fixture, 'agent_settled');
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(activation.manager.snapshot().goal?.iteration).toBe(iteration);
    activation.dispose();
  });

  it('lets a queued producer completion turn settle before continuing', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const background = createBackgroundWorkService([{ id: 'workflow-1', sessionId: 'manager-session' }]);
    activation.manager.bindBackgroundWork(background.service);
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');

    fixture.setPendingMessages(true);
    background.setItems([]);
    activation.manager.backgroundWorkChanged(background.service);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);

    fixture.setPendingMessages(false);
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2);
    activation.dispose();
  });

  it('fences a queued background invalidation when user input arrives', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const background = createBackgroundWorkService([{ id: 'runner-1', sessionId: 'manager-session' }]);
    activation.manager.bindBackgroundWork(background.service);
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');

    background.setItems([]);
    activation.manager.backgroundWorkChanged(background.service);
    for (const item of fixture.handlers.filter((candidate) => candidate.event === 'input')) {
      await item.handler({} as never, fixture.context);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
    activation.dispose();
  });

  it('rejects stale invalidations after the coordination service is replaced', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    const first = createBackgroundWorkService([{ id: 'task-old', sessionId: 'manager-session' }]);
    const second = createBackgroundWorkService([{ id: 'task-current', sessionId: 'manager-session' }]);
    activation.manager.bindBackgroundWork(first.service);
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');

    first.setItems([]);
    activation.manager.backgroundWorkChanged(first.service);
    activation.manager.bindBackgroundWork(second.service);
    await new Promise((resolve) => setImmediate(resolve));
    activation.manager.backgroundWorkChanged(first.service);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);

    second.setItems([]);
    activation.manager.backgroundWorkChanged(second.service);
    await vi.waitFor(() => expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2));
    activation.dispose();
  });
});
describe('Goal manager command and restore branches', () => {
  async function activate(fixture: ReturnType<typeof createFixture>) {
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    return activation;
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

  it('rejects invalid objectives without requiring a tool-surface binding', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await activation.manager.startFromCatalog('', undefined, fixture.context);
    expect(activation.manager.snapshot().goal).toBeUndefined();
    await fixture.commands.get('goal')?.handler('can start', fixture.context);
    expect(activation.manager.snapshot().goal?.status).toBe('active');
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.tools).toEqual([]);
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

  it('retains an incomplete budget-limited goal without exposing tools or admitting more work', async () => {
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
    await dispatch(fixture, 'agent_settled');
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    expect(fixture.activeTools()).toEqual(['read']);
    expect(fixture.tools).toEqual([]);
    activation.dispose();
  });

  it('lets the checker retain a genuinely repeated external blocker', async () => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    for (let turn = 0; turn < 2; turn += 1) {
      await finishGoalTurn(fixture);
      await dispatch(fixture, 'agent_settled');
    }
    fixture.check.mockImplementationOnce(async (request) =>
      verdict(request, 'goal_blocked', {
        reason: 'Deployment approval required',
        evidence: 'The deployment gate refused the last three attempts.',
        repeated_turns: 3,
      }),
    );
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal?.status).toBe('blocked');
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(3);
    expect(fixture.tools).toEqual([]);
    activation.dispose();
  });

  it('restores an active goal without duplicate kickoff and keeps paused goals dormant', async () => {
    const fixture = createFixture();
    const { createGoal } = await import('../../src/models/stateMachine');
    const { serializeGoalState } = await import('../../src/models/stateCodec');
    const restored = createGoal('restored', undefined, { id: 'restored', now: 10 });
    const session = fixture.context.sessionManager as unknown as {
      getBranch: () => unknown[];
      getEntries: () => unknown[];
    };
    session.getBranch = () => [{ type: 'custom', customType: 'goal-state', data: serializeGoalState(restored) }];
    session.getEntries = session.getBranch;
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    expect(activation.manager.snapshot().goal?.text).toBe('restored');
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.sendUserMessage).toHaveBeenCalledExactlyOnceWith('[goal]\nRun the remaining integration checks.', {
      deliverAs: 'followUp',
    });
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
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
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

describe('Goal checker concurrency', () => {
  it.each([
    'pause',
    'clear',
    'edit revised',
    'input',
    'session_shutdown',
    'session_tree',
    'leader-end',
    'catalog-start',
  ])('discards an in-flight completion after %s', async (action) => {
    const fixture = createFixture();
    const archive = vi.spyOn(fixture.history, 'archive');
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('original', fixture.context);
    let resolve!: (response: CheckResponse) => void;
    fixture.check.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    const [request, signal] = fixture.check.mock.calls[0]!;
    if (action === 'input' || action === 'session_tree') fixture.setPendingMessages(true);
    if (action === 'input' || action.startsWith('session_')) await dispatch(fixture, action);
    else if (action === 'leader-end') await activation.manager.endFromLeader(fixture.context);
    else if (action === 'catalog-start')
      await activation.manager.startFromCatalog('catalog replacement', undefined, fixture.context);
    else await fixture.commands.get('goal')?.handler(action, fixture.context);
    expect(signal.aborted).toBe(true);
    const delivered = fixture.sendUserMessage.mock.calls.length;
    resolve(verdict(request, 'goal_complete', { summary: 'Done.', evidence: 'Tests passed.' }));
    await new Promise((done) => setImmediate(done));
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(delivered);
    expect(archive.mock.calls.some(([entry]) => entry.status === 'complete')).toBe(false);
    if (action === 'clear' || action === 'leader-end') expect(activation.manager.snapshot().goal).toBeUndefined();
    else expect(activation.manager.snapshot().goal).toBeDefined();
    if (action === 'edit revised') expect(activation.manager.snapshot().goal?.text).toBe('revised');
    if (action === 'catalog-start') expect(activation.manager.snapshot().goal?.text).toBe('catalog replacement');
    activation.dispose();
  });

  it('aborts a check when work appears and makes one fresh check after its handoff', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('original', fixture.context);
    const background = createBackgroundWorkService();
    activation.manager.bindBackgroundWork(background.service);
    let resolve!: (response: CheckResponse) => void;
    fixture.check.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    const [request, signal] = fixture.check.mock.calls[0]!;
    background.setItems([{ id: 'new-runner', sessionId: 'manager-session' }]);
    activation.manager.backgroundWorkChanged(background.service);
    expect(signal.aborted).toBe(true);
    resolve(verdict(request, 'goal_complete', { summary: 'Done.', evidence: 'Old test result.' }));
    await new Promise((done) => setImmediate(done));
    expect(activation.manager.snapshot().goal).toBeDefined();
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    background.setItems([]);
    activation.manager.backgroundWorkChanged(background.service);
    activation.manager.backgroundWorkChanged(background.service);
    await dispatch(fixture, 'agent_settled');
    expect(fixture.check).toHaveBeenCalledTimes(2);
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2);
    activation.dispose();
  });

  it('retains the goal and pauses without hot retries after checker failure', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('original', fixture.context);
    fixture.check.mockRejectedValueOnce(new Error('provider unavailable'));
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal?.status).toBe('paused');
    expect(fixture.check).toHaveBeenCalledOnce();
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    await fixture.commands.get('goal')?.handler('resume', fixture.context);
    expect(activation.manager.snapshot().goal?.status).toBe('active');
    activation.dispose();
  });

  it('does not remove a verified goal when archival fails', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('original', fixture.context);
    vi.spyOn(fixture.history, 'archive').mockRejectedValueOnce(new Error('disk full'));
    fixture.check.mockImplementationOnce(async (request) =>
      verdict(request, 'goal_complete', { summary: 'Done.', evidence: 'Tests passed.' }),
    );
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal).toMatchObject({ text: 'original', status: 'paused' });
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    activation.dispose();
  });

  it('does not consume an iteration when continuation delivery fails', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('original', fixture.context);
    fixture.sendUserMessage.mockImplementationOnce(() => {
      throw new Error('admission failed');
    });
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal).toMatchObject({ status: 'paused', iteration: 0 });
    activation.dispose();
  });

  it('keeps user cancellation resumable rather than automatically restarting it', async () => {
    const fixture = createFixture();
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    await fixture.commands.get('goal')?.handler('original', fixture.context);
    await dispatch(fixture, 'agent_start');
    await dispatchEvent(fixture, 'agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal?.status).toBe('paused');
    expect(fixture.check).not.toHaveBeenCalled();
    await fixture.commands.get('goal')?.handler('resume', fixture.context);
    expect(fixture.sendUserMessage).toHaveBeenCalledTimes(2);
    activation.dispose();
  });
});

describe('Goal manager completion and archive branches', () => {
  async function activate(fixture: ReturnType<typeof createFixture>) {
    const activation = fixture.activateRuntime();
    await dispatch(fixture, 'session_start');
    return activation;
  }

  it('clears the goal on completion and archives it, with no follow-up turn', async () => {
    const fixture = createFixture();
    const archive = vi.spyOn(fixture.history, 'archive');
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    fixture.sendUserMessage.mockClear();
    fixture.check.mockImplementationOnce(async (request) =>
      verdict(request, 'goal_complete', {
        summary: 'All requirements verified.',
        evidence: 'Build and integration verification passed.',
      }),
    );
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot()).toMatchObject({ goal: undefined, execution: 'dormant' });
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ objective: 'first', status: 'complete' }));
    expect(fixture.sendUserMessage).not.toHaveBeenCalled();
    expect(fixture.context.ui.setStatus).toHaveBeenLastCalledWith('goal', undefined);
    expect(fixture.context.abort).not.toHaveBeenCalled();
    activation.dispose();
  });

  it.each([
    { summary: 'tests still fail', evidence: 'integration test failed' },
    { goal_id: 'stale', summary: 'Done.', evidence: 'Tests passed.' },
  ])('retains the goal after an invalid checker completion: %j', async (args) => {
    const fixture = createFixture();
    const activation = await activate(fixture);
    await fixture.commands.get('goal')?.handler('first', fixture.context);
    fixture.check.mockImplementationOnce(async (request) => verdict(request, 'goal_complete', args));
    await finishGoalTurn(fixture);
    await dispatch(fixture, 'agent_settled');
    expect(activation.manager.snapshot().goal?.status).toBe('paused');
    expect(fixture.sendUserMessage).toHaveBeenCalledOnce();
    activation.dispose();
  });
});
