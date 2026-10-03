import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { ToolCallEvent, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { dispatchHooks } from '../../../src/services/hookDispatch';
import type { HookDispatchScope } from '../../../src/services/hookDispatch/type';
import { registryEntries } from '../../../src/services/hookRegistry';
import type { HookSession } from '../../../src/services/hookRuntime/type';
import type { PluginHookDocument, RegistryGroup } from '../../../src/types/hooks';

const plugin: PluginHookDocument = {
  pluginRoot: '/plugin',
  config: { hooks: { PreToolUse: [{ hooks: [{ command: 'plugin-command' }] }] } },
};

function fixture(rows: NonNullable<RegistryGroup['hooks']>, plugins: PluginHookDocument[] = []) {
  const run = vi.fn<HookSession['runner']['run']>().mockResolvedValue({});
  const invoke = vi.fn<HookSession['modules']['invoke']>().mockResolvedValue({});
  const session: HookSession = {
    config: () => ({ settings: { projectTrust: 'ask' }, harness: readHarnessState({}), requiresRelaunch: false }),
    signal: new AbortController().signal,
    runner: { run },
    documents: {
      registry: async () => ({
        entries: registryEntries([
          {
            baseDirectory: '/repo',
            document: { groups: { core: { hooks: rows } } },
          },
        ]),
      }),
      plugins: async () => ({ documents: plugins, failures: [] }),
    },
    modules: { invoke, dispose: vi.fn() },
  };
  const scope: HookDispatchScope = {
    sessionId: 'child-1',
    parentSessionId: 'parent-1',
    agent: 'worker',
    cwd: '/repo',
    repoRoot: '/repo',
    isSubagent: false,
    signal: session.signal,
    sendMessage: vi.fn(),
    appendCustomEntry: vi.fn(),
  };
  return { session, run, invoke, scope };
}

function toolCall(): ToolCallEvent {
  return { type: 'tool_call', toolCallId: 'call-1', toolName: 'bash', input: { command: 'pwd' } };
}

function toolResult(): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: 'call-1',
    toolName: 'bash',
    input: { command: 'pwd' },
    content: [{ type: 'text', text: 'original' }],
    details: {},
    isError: false,
  };
}

describe('hook dispatcher', () => {
  it('orders modules and commands before plugins and passes native input mutations forward', async () => {
    const { session, run, invoke, scope } = fixture(
      [
        { event: 'PreToolUse', pi: { module: './last.ts', order: 2 } },
        { event: 'PreToolUse', pi: { command: 'registry-command', order: 1 } },
        { event: 'PreToolUse', pi: { module: './first.ts', order: 0 } },
      ],
      [plugin],
    );
    const order: string[] = [];
    invoke.mockImplementation(async (row, event, context) => {
      order.push(row.hook.command === undefined ? row.hook.module : row.hook.command);
      expect(context).toMatchObject({ sessionId: 'child-1', parentSessionId: 'parent-1', agent: 'worker' });
      if (event.type === 'tool_call' && event.toolName === 'bash' && row.rowId === '2')
        event.input.command = 'echo patched';
      return {};
    });
    run.mockImplementation(async (hook, payload) => {
      order.push(hook.command);
      expect(payload.tool_input).toEqual({ command: 'echo patched' });
      expect(payload).toMatchObject({ session_id: 'child-1', parent_session_id: 'parent-1', agent_type: 'worker' });
      return {};
    });
    const native = toolCall();
    const result = await dispatchHooks(session, scope, { eventName: 'PreToolUse', event: native });
    expect(result.toolCall).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(order).toEqual(['/repo/first.ts', 'registry-command', '/repo/last.ts', 'plugin-command']);
    expect(native.input).toEqual({ command: 'echo patched' });
  });

  it.each(['module', 'command'] as const)('ends the chain on explicit %s denial', async (binding) => {
    const { session, run, invoke, scope } = fixture(
      [
        { event: 'PreToolUse', pi: binding === 'module' ? { module: './deny.ts' } : { command: 'deny-command' } },
        { event: 'PreToolUse', pi: { command: 'later-command' } },
      ],
      [plugin],
    );
    invoke.mockResolvedValue({ result: { block: true, reason: 'module denied' } });
    run.mockResolvedValue({
      decision: { hookSpecificOutput: { permissionDecision: 'deny', reason: 'command denied' } },
    });
    expect((await dispatchHooks(session, scope, { eventName: 'PreToolUse', event: toolCall() })).toolCall).toEqual({
      block: true,
      reason: `${binding} denied`,
    });
    if (binding === 'module') expect(run).not.toHaveBeenCalled();
    else expect(run).toHaveBeenCalledTimes(1);
  });

  it('blocks additionalContext and keeps execution failures advisory', async () => {
    const { session, run, invoke, scope } = fixture([
      { event: 'PreToolUse', pi: { module: './broken.ts' } },
      { event: 'PreToolUse', pi: { command: 'later-command' } },
    ]);
    invoke.mockResolvedValue({
      failure: { command: '/repo/broken.ts', reason: 'module_failed', message: 'bad module' },
    });
    run.mockResolvedValue({ decision: { hookSpecificOutput: { additionalContext: 'Use a safe command.' } } });
    const result = await dispatchHooks(session, scope, { eventName: 'PreToolUse', event: toolCall() });
    expect(result.toolCall).toEqual({ block: true, reason: 'Use a safe command.' });
    expect(result.failures).toHaveLength(1);
    run.mockRejectedValue(new Error('command failed'));
    const failed = await dispatchHooks(session, scope, { eventName: 'PreToolUse', event: toolCall() });
    expect(failed.toolCall).toBeUndefined();
    expect(failed.failures.map(({ message }) => message)).toEqual(['bad module', 'command failed']);
  });

  it('propagates a rejected host effect instead of running later hooks', async () => {
    const { session, run, invoke, scope } = fixture([
      { event: 'PreToolUse', pi: { module: './effect.ts' } },
      { event: 'PreToolUse', pi: { command: 'later-command' } },
    ]);
    const admission = new Error('prompt rejected');
    invoke.mockRejectedValue(admission);
    await expect(dispatchHooks(session, scope, { eventName: 'PreToolUse', event: toolCall() })).rejects.toBe(admission);
    expect(run).not.toHaveBeenCalled();
  });

  it('skips only flagged rows for explicit subagents, including plugin hooks', async () => {
    const { session, run, invoke, scope } = fixture(
      [
        { event: 'PreToolUse', pi: { command: 'skip-command', skipInSubagent: true } },
        { event: 'PreToolUse', pi: { module: './run.ts' } },
      ],
      [plugin],
    );
    await dispatchHooks(session, { ...scope, isSubagent: true }, { eventName: 'PreToolUse', event: toolCall() });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.map(([hook]) => hook.command)).toEqual(['plugin-command']);
  });

  it('applies post-tool patches sequentially while command hooks append text', async () => {
    const { session, run, invoke, scope } = fixture([
      { event: 'PostToolUse', pi: { module: './first.ts' } },
      { event: 'PostToolUse', pi: { command: 'context-command' } },
      { event: 'PostToolUse', pi: { module: './last.ts' } },
    ]);
    invoke.mockImplementation(async (row, event) => {
      if (row.rowId === '0')
        return {
          result: { content: [{ type: 'text', text: 'module' }], details: { source: 'module' }, isError: true },
        };
      expect(event).toMatchObject({
        content: [
          { type: 'text', text: 'module' },
          { type: 'text', text: 'context' },
        ],
        details: { source: 'module' },
        isError: true,
      });
      return { result: { content: [{ type: 'text', text: 'final' }] } };
    });
    run.mockResolvedValue({ decision: { hookSpecificOutput: { additionalContext: 'context' } } });
    const result = await dispatchHooks(session, scope, { eventName: 'PostToolUse', event: toolResult() });
    expect(result.toolResult).toEqual({
      content: [{ type: 'text', text: 'final' }],
      details: { source: 'module' },
      isError: true,
    });
  });

  it('rejects invalid native input without replacing the tool input', async () => {
    const { session, invoke, scope } = fixture([{ event: 'PreToolUse', pi: { module: './bad.ts' } }]);
    invoke.mockImplementation(async (_row, event) => {
      if (event.type === 'tool_call') (event.input as Record<string, unknown>).invalid = () => undefined;
      return {};
    });
    const native = toolCall();
    const result = await dispatchHooks(session, scope, { eventName: 'PreToolUse', event: native });
    expect(native.input).toEqual({ command: 'pwd' });
    expect(result.failures.at(-1)?.message).toContain('JSON object');
  });

  it.each([null, true, 1, 'invalid', []])('keeps non-object input patches advisory: %j', async (input) => {
    const { session, invoke, scope } = fixture([{ event: 'PreToolUse', pi: { module: './bad.ts' } }]);
    invoke.mockImplementation(async (_row, event) => {
      Object.assign(event, { input });
      return {};
    });
    const native = toolCall();
    const result = await dispatchHooks(session, scope, { eventName: 'PreToolUse', event: native });
    expect(native.input).toEqual({ command: 'pwd' });
    expect(result.failures).toHaveLength(1);
  });

  it('keeps uncloneable event details advisory and still runs command hooks', async () => {
    const { session, invoke, run, scope } = fixture([
      { event: 'PostToolUse', pi: { module: './module.ts' } },
      { event: 'PostToolUse', pi: { command: 'command' } },
    ]);
    const native = { ...toolResult(), details: () => undefined };
    const result = await dispatchHooks(session, scope, { eventName: 'PostToolUse', event: native });
    expect(result.failures).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.toolResult?.content).toEqual(
      expect.arrayContaining([{ type: 'text', text: expect.stringContaining('did not complete') }]),
    );
  });

  it('stops before invoking any hook when the operation is cancelled', async () => {
    const { session, invoke, scope } = fixture([{ event: 'PreToolUse', pi: { module: './cancelled.ts' } }]);
    const operation = new AbortController();
    operation.abort(new Error('cancelled'));
    await expect(
      dispatchHooks(
        session,
        { ...scope, operationSignal: operation.signal },
        { eventName: 'PreToolUse', event: toolCall() },
      ),
    ).rejects.toThrow('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });
});
