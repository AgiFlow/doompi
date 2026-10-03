import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HEADLESS_HOST_SERVICE, DoomHeadlessPromptAdmissionError } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/serverFacet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet as hookServerFacet } from '../../../generated/server';
import { registryEntries } from '../../../src/services/hookRegistry';
import { createHookRuntime } from '../../../src/services/hookRuntime';
import { createServerHooks } from '../../../src/services/serverHooks';
import type { HookRunner } from '../../../src/types/hooks';
import { piHarness } from '../../helpers/piSession';

describe('hook headless facet', () => {
  it('records lifecycle hooks, clears shutdown status, and exposes authoring guidance', async () => {
    let resource: DoomHeadlessResource | undefined;
    const hooks: DoomHeadlessHook[] = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const registration = () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    };
    const appendCustomEntry = vi.fn();
    const setStatus = vi.fn();
    const execution = {
      sessionId: 'headless-facet',
      cwd: '/repo',
      repoRoot: '/repo',
      environment: {},
      session: { appendCustomEntry },
      client: { setStatus },
    } as unknown as DoomHeadlessExecutionContext;
    const host = {
      context: execution,
      registerResource: (registered: DoomHeadlessResource) => {
        resource = registered;
        return registration();
      },
      registerHook: (hook: DoomHeadlessHook) => {
        hooks.push(hook);
        return registration();
      },
    } as unknown as DoomHeadlessHostService;
    const context = new Context();
    context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' });
    context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
    const close = await hookServerFacet.apply(context);
    if (!resource) throw new Error('Hook authoring resource was not registered');

    const beforeStart = hooks.find(({ event }) => event === 'before_agent_start');
    const shutdown = hooks.find(({ event }) => event === 'session_shutdown');
    if (!beforeStart || !shutdown) throw new Error('Hook lifecycle handlers were not registered');

    await beforeStart.handle({ type: 'before_agent_start', prompt: 'continue' } as never, execution);
    expect(appendCustomEntry).toHaveBeenCalledWith('doom-hook', {
      version: 1,
      event: 'before_agent_start',
      data: { type: 'before_agent_start', prompt: 'continue' },
    });
    await shutdown.handle({ type: 'session_shutdown' } as never, execution);
    expect(setStatus).toHaveBeenCalledWith('doom-hook', undefined);
    expect(await resource.read(execution)).toContain('hook');

    await close?.();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
  it('dispatches named tool handlers once, preserves journaling and clears statuses', async () => {
    const state = piHarness({ root: '/repo' });
    const run = vi.fn<HookRunner['run']>().mockImplementation(async (_hook, payload) => ({
      decision: {
        hookSpecificOutput: {
          additionalContext: payload.hook_event_name === 'PreToolUse' ? 'Use the safe path.' : 'post context',
        },
      },
    }));
    const runtime = createHookRuntime(state.cordis, {
      runner: { run },
      documents: {
        registry: async () => ({
          entries: registryEntries([
            {
              baseDirectory: '/repo',
              document: {
                groups: {
                  core: {
                    hooks: [
                      { event: 'PreToolUse', pi: { command: 'pre' } },
                      { event: 'PostToolUse', pi: { command: 'post' } },
                    ],
                  },
                },
              },
            },
          ]),
        }),
        plugins: async () => ({ documents: [], failures: [] }),
      },
    });
    const hooks = createServerHooks(() => runtime);
    const appendCustomEntry = vi.fn();
    const setStatus = vi.fn();
    const execution = {
      sessionId: 'parent',
      cwd: '/repo',
      repoRoot: '/repo',
      environment: {},
      session: { appendCustomEntry, admitPrompt: vi.fn() },
      client: { setStatus },
    } as unknown as DoomHeadlessExecutionContext;
    const dispose = vi.spyOn(runtime.session.modules, 'dispose');
    try {
      expect(
        await hooks.toolCall.handle({ toolCallId: 'call', toolName: 'bash', args: { command: 'pwd' } }, execution),
      ).toEqual({ block: { reason: 'Use the safe path.' } });
      const event = {
        type: 'tool_result',
        toolCallId: 'call',
        toolName: 'bash',
        args: { command: 'pwd' },
        content: [{ type: 'text', text: 'original' }],
        details: {},
        isError: false,
      };
      expect(await hooks.toolResult.handle(event, execution)).toMatchObject({
        content: [
          { type: 'text', text: 'original' },
          { type: 'text', text: 'post context' },
        ],
      });
      expect(run.mock.calls.map(([hook]) => hook.command)).toEqual(['pre', 'post']);
      expect(appendCustomEntry).toHaveBeenCalledWith('doom-hook', { version: 1, event: 'tool_result', data: event });
      expect(setStatus.mock.calls).toContainEqual(['repository-hooks:call:pre', undefined]);
      expect(setStatus.mock.calls).toContainEqual(['repository-hooks:call:post', undefined]);
      await runtime.dispose();
      await runtime.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
      await hooks.toolCall.handle({ toolCallId: 'stale', toolName: 'bash', args: {} }, execution);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
      await state.cordis.fiber.dispose();
    }
  });

  it('propagates failure-report admission rejection and cancellation', async () => {
    const state = piHarness({ root: '/repo' });
    const run = vi
      .fn<HookRunner['run']>()
      .mockResolvedValue({ failure: { command: 'broken', reason: 'hook_execution', message: 'broken hook' } });
    const runtime = createHookRuntime(state.cordis, {
      runner: { run },
      documents: {
        registry: async () => ({
          entries: registryEntries([
            {
              baseDirectory: '/repo',
              document: { groups: { core: { hooks: [{ event: 'PreToolUse', pi: { command: 'broken' } }] } } },
            },
          ]),
        }),
        plugins: async () => ({ documents: [], failures: [] }),
      },
    });
    const error = new DoomHeadlessPromptAdmissionError('admission rejected');
    const admitPrompt = vi.fn().mockRejectedValue(error);
    const setStatus = vi.fn();
    const execution = {
      sessionId: 'parent',
      cwd: '/repo',
      repoRoot: '/repo',
      environment: {},
      session: { admitPrompt },
      client: { setStatus },
    } as unknown as DoomHeadlessExecutionContext;
    const hooks = createServerHooks(() => runtime);
    try {
      await expect(hooks.toolCall.handle({ toolCallId: 'call', toolName: 'bash', args: {} }, execution)).rejects.toBe(
        error,
      );
      expect(admitPrompt).toHaveBeenCalledTimes(1);
      expect(setStatus).toHaveBeenLastCalledWith('repository-hooks:call:pre', undefined);
      const operation = new AbortController();
      operation.abort(new Error('cancelled'));
      await expect(
        hooks.toolCall.handle(
          { toolCallId: 'cancelled', toolName: 'bash', args: {} },
          { ...execution, signal: operation.signal },
        ),
      ).rejects.toThrow('cancelled');
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
      await state.cordis.fiber.dispose();
    }
  });
});
