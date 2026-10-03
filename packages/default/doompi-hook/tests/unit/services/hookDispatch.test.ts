import { readHarnessState } from '@agimon-ai/doompi-config';
import type { ToolCallEvent, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { dispatchHooks } from '../../../src/services/hookDispatch';
import type { HookDispatchScope } from '../../../src/services/hookDispatch/type';
import { registryEntries } from '../../../src/services/hookRegistry';
import { createHookSession } from '../../../src/services/hookRuntime';
import type { HookSession } from '../../../src/services/hookRuntime/type';
import type { RegistryHook } from '../../../src/types/hooks';
import { createHookRunnerDouble } from '../../helpers/piSession';

function fixture(rows: RegistryHook[], plugins: HookSession['documents']['pluginHooks'] = []) {
  const runner = createHookRunnerDouble();
  const invoke = vi.fn<HookSession['modules']['invoke']>();
  const session: HookSession = {
    ...createHookSession(readHarnessState({}), undefined, {
      documents: {
        registryEntries: registryEntries([{
          baseDirectory: '/repo',
          document: { groups: [{ id: 'core', hooks: rows }] },
        }]),
        pluginHooks: plugins,
        failures: [],
      },
      runner: runner.runner,
    }),
    modules: { invoke, dispose: vi.fn() },
  };
  const scope: HookDispatchScope = {
    sessionId: 'child-1', parentSessionId: 'parent-1', agentType: 'worker',
    cwd: '/repo', isSubagent: false,
    signal: new AbortController().signal,
    sendMessage: vi.fn(), appendSystemPrompt: vi.fn(),
  };
  return { session, runner, invoke, scope };
}

function toolCall(): ToolCallEvent {
  return { type: 'tool_call', toolCallId: 'call-1', toolName: 'bash', input: { command: 'pwd' } };
}

function toolResult(): ToolResultEvent {
  return { type: 'tool_result', toolCallId: 'call-1', toolName: 'bash', input: { command: 'pwd' }, content: [{ type: 'text', text: 'original' }], details: {}, isError: false };
}

describe('hook dispatcher', () => {
  it('orders modules and commands before plugins and passes native input mutations forward', async () => {
    const { session, runner, invoke, scope } = fixture([
      { id: 'last', event: 'PreToolUse', module: './last.ts', order: 2 },
      { id: 'command', event: 'PreToolUse', command: 'registry-command', order: 1 },
      { id: 'first', event: 'PreToolUse', module: './first.ts', order: 0 },
    ], [{ event: 'PreToolUse', matcher: '', hook: { type: 'command', command: 'plugin-command' } }]);
    const order: string[] = [];
    invoke.mockImplementation(async (hook, event, context) => {
      order.push(hook.rowId ?? '');
      expect(context).toMatchObject({ sessionId: 'child-1', parentSessionId: 'parent-1', agentType: 'worker' });
      if (event.type === 'tool_call' && hook.rowId === 'first') event.input.command = 'echo patched';
    });
    runner.runPreToolUseHook.mockImplementation(async (hook, payload) => {
      order.push(hook.command ?? '');
      expect(payload.tool_input).toEqual({ command: 'echo patched' });
      expect(payload).toMatchObject({ session_id: 'child-1', parent_session_id: 'parent-1', agent_type: 'worker' });
      return undefined;
    });
    const native = toolCall();
    expect(await dispatchHooks(session, scope, { event: 'PreToolUse', native })).toBeUndefined();
    expect(order).toEqual(['first', 'registry-command', 'last', 'plugin-command']);
    expect(native.input).toEqual({ command: 'echo patched' });
  });

  it.each(['module', 'command'] as const)('ends the chain on explicit %s denial', async (binding) => {
    const first: RegistryHook = binding === 'module'
      ? { id: 'first', event: 'PreToolUse', module: './deny.ts' }
      : { id: 'first', event: 'PreToolUse', command: 'deny-command' };
    const { session, runner, invoke, scope } = fixture([
      first,
      { id: 'later', event: 'PreToolUse', command: 'later-command' },
    ], [{ event: 'PreToolUse', matcher: '', hook: { type: 'command', command: 'plugin-command' } }]);
    invoke.mockResolvedValue({ block: true, reason: 'module denied' });
    runner.runPreToolUseHook.mockResolvedValue({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'command denied' } });
    expect(await dispatchHooks(session, scope, { event: 'PreToolUse', native: toolCall() })).toEqual({ block: true, reason: `${binding} denied` });
    if (binding === 'module') expect(runner.runPreToolUseHook).not.toHaveBeenCalled();
    else expect(runner.runPreToolUseHook).toHaveBeenCalledTimes(1);
  });

  it('keeps execution failures advisory but propagates a rejected host effect', async () => {
    const { session, runner, invoke, scope } = fixture([
      { id: 'broken', event: 'PreToolUse', module: './broken.ts' },
      { id: 'later', event: 'PreToolUse', command: 'later-command' },
    ]);
    invoke.mockResolvedValue({ kind: 'advisory-failure', message: 'bad module' });
    await expect(dispatchHooks(session, scope, { event: 'PreToolUse', native: toolCall() })).resolves.toBeUndefined();
    expect(runner.runPreToolUseHook).toHaveBeenCalledTimes(1);
    const admission = new Error('prompt rejected');
    invoke.mockRejectedValue(admission);
    await expect(dispatchHooks(session, scope, { event: 'PreToolUse', native: toolCall() })).rejects.toBe(admission);
    expect(runner.runPreToolUseHook).toHaveBeenCalledTimes(1);
  });

  it('skips only flagged rows for explicit subagents, including plugin hooks', async () => {
    const { session, runner, invoke, scope } = fixture([
      { id: 'skip', event: 'PreToolUse', command: 'skip-command', skipInSubagent: true },
      { id: 'run', event: 'PreToolUse', module: './run.ts' },
    ], [{ event: 'PreToolUse', matcher: '', hook: { type: 'command', command: 'plugin-command' } }]);
    scope.isSubagent = true;
    await dispatchHooks(session, scope, { event: 'PreToolUse', native: toolCall() });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(runner.runPreToolUseHook.mock.calls.map(([hook]) => hook.command)).toEqual(['plugin-command']);
  });

  it('applies post-tool patches sequentially while command hooks append text', async () => {
    const { session, runner, invoke, scope } = fixture([
      { id: 'first', event: 'PostToolUse', module: './first.ts' },
      { id: 'command', event: 'PostToolUse', command: 'context-command' },
      { id: 'last', event: 'PostToolUse', module: './last.ts' },
    ]);
    invoke.mockImplementation(async (hook, event) => {
      if (hook.rowId === 'first') return { content: [{ type: 'text', text: 'module' }], details: { source: 'module' }, isError: true };
      expect(event).toMatchObject({ content: [{ type: 'text', text: 'module' }, { type: 'text', text: 'context' }], details: { source: 'module' }, isError: true });
      return { content: [{ type: 'text', text: 'final' }] };
    });
    runner.runPostToolUseHook.mockResolvedValue({ hookSpecificOutput: { additionalContext: 'context' } });
    const result = await dispatchHooks(session, scope, { event: 'PostToolUse', native: toolResult() });
    expect(result).toEqual({ content: [{ type: 'text', text: 'final' }], details: { source: 'module' }, isError: true });
  });

  it('rejects invalid native input without replacing the tool input', async () => {
    const { session, invoke, scope } = fixture([{ id: 'bad', event: 'PreToolUse', module: './bad.ts' }]);
    invoke.mockImplementation(async (_hook, event) => {
      if (event.type === 'tool_call') event.input.invalid = () => undefined;
    });
    const native = toolCall();
    await dispatchHooks(session, scope, { event: 'PreToolUse', native });
    expect(native.input).toEqual({ command: 'pwd' });
    expect(session.failures.at(-1)?.message).toContain('invalid tool input');
  });

  it('stops before invoking any hook when the operation is cancelled', async () => {
    const { session, invoke, scope } = fixture([{ id: 'cancelled', event: 'PreToolUse', module: './cancelled.ts' }]);
    const operation = new AbortController();
    scope.operationSignal = operation.signal;
    operation.abort(new Error('cancelled'));
    await expect(dispatchHooks(session, scope, { event: 'PreToolUse', native: toolCall() })).rejects.toThrow('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });
});
