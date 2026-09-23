import {
  DOOM_BACKGROUND_WORK_CHANGED_EVENT,
  DOOM_BACKGROUND_WORK_SERVICE,
  type DoomBackgroundWorkService,
  type BackgroundWorkItem,
} from '@agimon-ai/doompi-core/backgroundWork';
import type {
  DoomHeadlessEventName,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessSelection,
  DoomHeadlessToolCompletionRequest,
  DoomHeadlessToolCompletionResult,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_MINOR_MODE_CATALOG_SERVICE } from '@agimon-ai/doompi-minor-mode';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { decodeGoalStateEntries } from '../../src/models/stateCodec';
import { createGoal } from '../../src/models/stateMachine';
import { createGoalServer } from '../../src/services/goalServer';
import type { ActiveGoal } from '../../src/types/goal';
import { GOAL_VIEW_STATUS_KEY } from '../../src/types/goalView';
import type { GoalHistoryEntry } from '../../src/types/history';

function verdict(
  request: DoomHeadlessToolCompletionRequest,
  name = 'goal_continue',
  args: Record<string, unknown> = {},
): DoomHeadlessToolCompletionResult {
  const { goal_id } = JSON.parse(request.input) as { goal_id: string };
  return {
    toolCalls: [
      {
        id: 'checker-call',
        name,
        arguments: {
          goal_id,
          ...(name === 'goal_continue' ? { instruction: 'Run and inspect the integration tests.' } : {}),
          ...args,
        },
      },
    ],
    usage: { totalTokens: 10 },
  };
}

async function fixture(restored?: ActiveGoal) {
  let selection: DoomHeadlessSelection = { majorMode: 'copilot', activeLayers: [], domains: [], state: {} };
  const selections = new Set<(value: DoomHeadlessSelection) => void | Promise<void>>();
  const entries: Record<string, unknown>[] = restored
    ? [{ type: 'custom', customType: 'goal-state', data: { goal: restored } }]
    : [];
  let items: BackgroundWorkItem[] = [];
  let errors: Array<{ provider: string; message: string }> = [];
  const background: DoomBackgroundWorkService = {
    generation: 'server-background',
    register: vi.fn(),
    snapshot: vi.fn((sessionId) => ({ items: items.filter((item) => item.sessionId === sessionId), errors })),
  };
  const check = vi.fn(async (_reference: string, request: DoomHeadlessToolCompletionRequest) => verdict(request));
  const history = {
    archive: vi.fn(async (entry: GoalHistoryEntry) => entry),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    restart: vi.fn(),
  };
  const execution = {
    cwd: '/test/goal-repository',
    repoRoot: '/test/goal-repository',
    sessionId: 'server-session',
    environment: {},
    get selection() {
      return selection;
    },
    model: { provider: 'test', id: 'checker' },
    toolCompletion: { complete: check },
    client: { notify: vi.fn(), request: vi.fn().mockResolvedValue(true), setStatus: vi.fn() },
    session: {
      entries: vi.fn(async () => entries),
      appendCustomEntry: vi.fn(async (customType: string, data: unknown) => {
        entries.push({ type: 'custom', customType, data: structuredClone(data) });
      }),
      admitPrompt: vi.fn(async (_text: string, _delivery?: string) => undefined),
      prompt: vi.fn(),
      abort: vi.fn(async () => undefined),
      compact: vi.fn(),
      activity: vi.fn(async () => ({ isIdle: true, hasPendingMessages: false })),
    },
    shutdown: vi.fn(),
  } satisfies DoomHeadlessExecutionContext;
  const host = {
    context: execution,
    subscribeSelection(listener: (value: DoomHeadlessSelection) => void | Promise<void>) {
      selections.add(listener);
      return () => {
        selections.delete(listener);
      };
    },
    async changeSelection(change: { axis: 'state'; key: string; values: string[] }) {
      selection = { ...selection, state: { ...selection.state, [change.key]: change.values } };
      for (const listener of selections) await listener(selection);
    },
  } as unknown as DoomHeadlessHostService;
  const root = new Context();
  root.provide(DOOM_BACKGROUND_WORK_SERVICE, background);
  root.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, {
    registerOwner: () => ({ publish: vi.fn(), dispose: vi.fn() }),
  } as never);
  const plugin = createGoalServer(host, history);
  for (const service of plugin.services ?? []) root.plugin(service);
  const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
  const event = async (name: DoomHeadlessEventName, payload: Record<string, unknown> = {}) => {
    const hook = plugin.hooks?.find((candidate) => candidate.event === name);
    if (!hook) throw new Error(`Missing hook: ${name}`);
    await hook.handle(payload as never, execution);
    await drain();
  };
  await event('session_start');
  const command = async (args: string) => {
    await plugin.commands[0]!.execute(args, execution);
    await drain();
  };
  const changed = async () => {
    root.emit(DOOM_BACKGROUND_WORK_CHANGED_EVENT, {
      provider: 'test',
      generation: background.generation,
      kind: 'updated',
    });
    await drain();
  };
  let run = 0;
  return {
    plugin,
    root,
    background,
    history,
    check,
    execution,
    entries,
    command,
    event,
    changed,
    drain,
    goal: () => decodeGoalStateEntries(entries).goal,
    selection: () => selection,
    setItems: (next: BackgroundWorkItem[]) => {
      items = next;
    },
    setErrors: (next: typeof errors) => {
      errors = next;
    },
    async finish(status = 'completed') {
      run += 1;
      await event('agent_start', { runId: `run-${run}` });
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Recorded concrete progress.' }],
        stopReason: 'stop',
      };
      entries.push({ type: 'message', message });
      await event('message_end', { message });
      await event('agent_settled', { runId: `run-${run}`, status });
    },
    async close() {
      await plugin.onDispose?.({ context: root } as never);
      await root.fiber.dispose();
    },
  };
}

describe('server Goal checker lifecycle', () => {
  it('wakes on kickoff, continues once with a targeted instruction, and exposes no main-agent lifecycle tools', async () => {
    const test = await fixture();
    expect(test.check).not.toHaveBeenCalled();
    await test.command('Ship it');
    expect(test.execution.session.admitPrompt).toHaveBeenCalledExactlyOnceWith('[goal]\nShip it', 'steer');
    await test.finish();
    await test.event('agent_settled', { runId: 'run-1', status: 'completed' });
    expect(test.check).toHaveBeenCalledOnce();
    expect(test.check.mock.calls[0]?.[1].tools.map((tool) => tool.name)).toEqual([
      'goal_complete',
      'goal_continue',
      'goal_blocked',
    ]);
    expect(test.plugin.tools).toEqual([]);
    expect(test.execution.session.admitPrompt).toHaveBeenLastCalledWith(
      '[goal]\nRun and inspect the integration tests.',
      'prompt',
    );
    expect(test.execution.session.admitPrompt).toHaveBeenCalledTimes(2);
    expect(test.goal()).toMatchObject({ status: 'active', iteration: 1, tokensUsed: 10 });
    await test.close();
  });

  it.each(['runner', 'team', 'workflow'])('waits for %s work and the pending result handoff', async (provider) => {
    const test = await fixture();
    await test.command('Ship it');
    test.setItems([{ id: 'work-1', sessionId: 'server-session', provider }]);
    await test.finish();
    expect(test.check).not.toHaveBeenCalled();
    test.execution.session.activity.mockResolvedValue({ isIdle: true, hasPendingMessages: true });
    test.setItems([]);
    await test.changed();
    expect(test.check).not.toHaveBeenCalled();
    test.execution.session.activity.mockResolvedValue({ isIdle: true, hasPendingMessages: false });
    await test.finish();
    expect(test.check).toHaveBeenCalledOnce();
    expect(test.background.snapshot).toHaveBeenCalledWith('server-session');
    await test.close();
  });

  it('ignores foreign-session work but fails closed on provider errors', async () => {
    const test = await fixture();
    await test.command('Ship it');
    test.setItems([{ id: 'other', sessionId: 'other-session', provider: 'team' }]);
    test.setErrors([{ provider: 'runner', message: 'unavailable' }]);
    await test.finish();
    expect(test.check).not.toHaveBeenCalled();
    test.setErrors([]);
    await test.changed();
    expect(test.check).toHaveBeenCalledOnce();
    await test.close();
  });

  it('archives evidence before removing the active goal, mode, and UI status', async () => {
    const test = await fixture();
    await test.command('Ship it');
    test.check.mockImplementationOnce(async (_reference, request) =>
      verdict(request, 'goal_complete', {
        summary: 'All requirements met.',
        evidence: 'Build and integration test commands passed.',
      }),
    );
    await test.finish();
    expect(test.history.archive).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', reason: expect.stringContaining('Evidence:') }),
    );
    expect(test.goal()).toBeUndefined();
    expect(test.selection().state?.['minor-mode']).toEqual([]);
    expect(test.execution.client.setStatus).toHaveBeenLastCalledWith(GOAL_VIEW_STATUS_KEY, undefined);
    expect(test.execution.session.admitPrompt).toHaveBeenCalledOnce();
    expect(test.execution.session.abort).not.toHaveBeenCalled();
    await test.close();
  });

  it.each(['pause', 'clear', 'edit Revised objective'])(
    'invalidates an in-flight completion on %s without blocking the command',
    async (action) => {
      const test = await fixture();
      await test.command('Ship it');
      let resolve!: (value: DoomHeadlessToolCompletionResult) => void;
      test.check.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await test.finish();
      const request = test.check.mock.calls[0]![1];
      await test.command(action);
      expect(request.signal?.aborted).toBe(true);
      const admitted = test.execution.session.admitPrompt.mock.calls.length;
      resolve(verdict(request, 'goal_complete', { summary: 'Done.', evidence: 'Old verification evidence.' }));
      await test.drain();
      expect(test.history.archive.mock.calls.some(([entry]) => entry.status === 'complete')).toBe(false);
      expect(test.execution.session.admitPrompt).toHaveBeenCalledTimes(admitted);
      if (action === 'pause') expect(test.goal()?.status).toBe('paused');
      if (action === 'clear') expect(test.goal()).toBeUndefined();
      if (action.startsWith('edit')) expect(test.goal()?.text).toBe('Revised objective');
      await test.close();
    },
  );

  it('discards completion when background work begins during inference', async () => {
    const test = await fixture();
    await test.command('Ship it');
    let resolve!: (value: DoomHeadlessToolCompletionResult) => void;
    test.check.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await test.finish();
    const request = test.check.mock.calls[0]![1];
    test.setItems([{ id: 'late', sessionId: 'server-session', provider: 'workflow' }]);
    await test.changed();
    expect(request.signal?.aborted).toBe(true);
    resolve(verdict(request, 'goal_complete', { summary: 'Done.', evidence: 'Old result.' }));
    await test.drain();
    expect(test.goal()?.status).toBe('active');
    expect(test.history.archive).not.toHaveBeenCalled();
    test.setItems([]);
    await test.changed();
    expect(test.check).toHaveBeenCalledTimes(2);
    await test.close();
  });

  it('retains stopped goals, preserves identity when editing, and wakes only on explicit resume', async () => {
    const test = await fixture();
    await test.command('Ship it');
    const id = test.goal()?.id;
    await test.command('pause');
    await test.command('edit Refined objective');
    expect(test.goal()).toMatchObject({ id, status: 'paused', text: 'Refined objective' });
    expect(test.execution.session.abort).toHaveBeenCalledOnce();
    expect(test.execution.session.admitPrompt).toHaveBeenCalledOnce();
    await test.command('resume');
    expect(test.execution.session.admitPrompt).toHaveBeenLastCalledWith('[goal]\nRefined objective', 'steer');
    await test.close();
  });

  it('pauses after checker failure or failed archival, without automatic retries', async () => {
    const test = await fixture();
    await test.command('Ship it');
    test.check.mockRejectedValueOnce(new Error('provider unavailable'));
    await test.finish();
    await test.event('agent_settled');
    expect(test.goal()?.status).toBe('paused');
    expect(test.check).toHaveBeenCalledOnce();
    await test.command('resume');
    test.history.archive.mockRejectedValueOnce(new Error('history unavailable'));
    test.check.mockImplementationOnce(async (_reference, request) =>
      verdict(request, 'goal_complete', { summary: 'Done.', evidence: 'Tests passed.' }),
    );
    await test.finish();
    expect(test.goal()?.status).toBe('paused');
    expect(test.execution.session.admitPrompt).toHaveBeenCalledTimes(2);
    await test.close();
  });

  it('charges checker usage and stops substantive continuation at the budget', async () => {
    const test = await fixture();
    await test.command('--tokens 5 Ship it');
    await test.finish();
    expect(test.goal()).toMatchObject({ status: 'budget_limited', tokensUsed: 10 });
    expect(test.execution.session.admitPrompt).toHaveBeenCalledOnce();
    await test.command('resume');
    expect(test.execution.session.admitPrompt).toHaveBeenCalledOnce();
    await test.close();
  });

  it('does not restart a user-aborted run', async () => {
    const test = await fixture();
    await test.command('Ship it');
    await test.finish('aborted');
    expect(test.goal()?.status).toBe('paused');
    expect(test.check).not.toHaveBeenCalled();
    await test.close();
  });

  it('checks restored active goals without sending a duplicate kickoff', async () => {
    const test = await fixture(createGoal('Restored goal', undefined, { id: 'restored', now: 1000 }));
    expect(test.check).toHaveBeenCalledOnce();
    expect(test.execution.session.admitPrompt).toHaveBeenCalledExactlyOnceWith(
      '[goal]\nRun and inspect the integration tests.',
      'prompt',
    );
    await test.close();
  });
});
