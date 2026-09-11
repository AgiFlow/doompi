import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { describe, expect, it, vi } from 'vitest';
import { createRpcTranscript, type RpcTranscript } from '../../../../src/services/server/rpcTranscript.ts';
import { createAgentSessionRuntime } from '../../../../src/adapters/server/piSessionRuntime.ts';
import type { AgentProcess, SessionFrame } from '../../../../src/types/server/session.ts';

function fixture(transcript?: RpcTranscript) {
  const listeners: Array<(frame: SessionFrame) => void> = [];
  const sent: SessionFrame[] = [];
  const agent: AgentProcess = {
    send: (frame) => {
      sent.push(frame);
    },
    onFrame: (listener) => {
      listeners.push(listener);
    },
    exited: new Promise<number>(() => {}),
    endInput: () => {},
    stop: () => {},
  };
  const runtime = createAgentSessionRuntime({ agent, sessionId: 's1', sessionName: 'test', cwd: '/test', transcript });
  return {
    runtime,
    sent,
    emit: (frame: SessionFrame) => {
      for (const listener of listeners) listener(frame);
    },
  };
}

describe('typed session runtime controls', () => {
  it('correlates concurrent info replies by id and command, including out-of-order results', async () => {
    const { runtime, sent, emit } = fixture();
    const commands = runtime.getCommands(BACKGROUND_CONTEXT);
    const models = runtime.getAvailableModels(BACKGROUND_CONTEXT);
    expect(sent.map((frame) => frame.type)).toEqual(['get_commands', 'get_available_models']);
    emit({ type: 'response', id: sent[0].id, command: 'get_available_models', success: true, data: { models: [] } });
    emit({
      type: 'response',
      id: sent[1].id,
      command: 'get_available_models',
      success: true,
      data: { models: [{ provider: 'test', id: 'm', apiKey: 'not forwarded' }] },
    });
    emit({
      type: 'response',
      id: sent[0].id,
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'run', source: 'extension' }] },
    });
    await expect(commands).resolves.toEqual([{ name: 'run', source: 'extension' }]);
    await expect(models).resolves.toEqual([{ provider: 'test', id: 'm' }]);
    await runtime.dispose();
  });

  it('forwards queue and rewind controls and propagates command failures', async () => {
    const { runtime, sent, emit } = fixture();
    const queue = runtime.clearQueue(BACKGROUND_CONTEXT);
    emit({
      type: 'response',
      id: sent[0].id,
      command: 'clear_queue',
      success: true,
      data: { steering: ['one'], followUp: [] },
    });
    await expect(queue).resolves.toEqual({ steering: ['one'], followUp: [] });
    const rewind = runtime.rewind({ itemId: 'user-123', summarize: true }, BACKGROUND_CONTEXT);
    expect(sent[1]).toMatchObject({ type: 'get_entries' });
    emit({
      type: 'response',
      id: sent[1].id,
      command: 'get_entries',
      success: true,
      data: {
        leafId: 'entry',
        entries: [
          { id: 'entry', parentId: null, type: 'message', message: { role: 'user', timestamp: 123, content: 'hello' } },
        ],
      },
    });
    await Promise.resolve();
    expect(sent[2]).toMatchObject({
      type: 'navigate_tree',
      targetId: 'entry',
      entryId: 'entry',
      options: { summarize: true },
    });
    emit({ type: 'response', id: sent[2].id, command: 'navigate_tree', success: false, error: 'history is read-only' });
    await expect(rewind).rejects.toThrow('history is read-only');
    await runtime.dispose();
  });

  it('preserves images and extension dialog identity', async () => {
    const { runtime, sent, emit } = fixture();
    const images = [{ type: 'image' as const, data: 'image', mimeType: 'image/png' }];
    const follow = runtime.followUp({ text: 'later', images }, BACKGROUND_CONTEXT);
    expect(sent[0]).toMatchObject({ type: 'follow_up', message: 'later', images });
    emit({ type: 'response', id: sent[0].id, command: 'follow_up', success: true });
    await follow;
    await runtime.extensionUiResponse({ id: 'dialog', confirmed: false }, BACKGROUND_CONTEXT);
    expect(sent[1]).toEqual({ type: 'extension_ui_response', id: 'dialog', confirmed: false });
    await runtime.dispose();
  });

  it('rejects pending calls and prompts on disposal instead of leaving unresolved promises', async () => {
    const { runtime } = fixture();
    const info = runtime.getSessionStats(BACKGROUND_CONTEXT);
    const prompt = runtime.prompt('hello', BACKGROUND_CONTEXT);
    const infoFailure = expect(info).rejects.toThrow('disposed');
    const promptFailure = expect(prompt).rejects.toThrow('disposed');
    await runtime.dispose();
    await Promise.all([infoFailure, promptFailure]);
  });
  it('hydrates persisted custom projections without a legacy hub attachment', async () => {
    const { runtime, sent, emit } = fixture();
    const ready = runtime.initialize();
    emit({
      type: 'response',
      id: sent[0].id,
      command: 'get_state',
      success: true,
      data: { model: { provider: 'test', id: 'model' }, thinkingLevel: 'off', isStreaming: false },
    });
    await Promise.resolve();
    expect(sent[1].type).toBe('get_entries');
    emit({
      type: 'response',
      id: sent[1].id,
      command: 'get_entries',
      success: true,
      data: {
        leafId: 'context',
        entries: [
          { id: 'context', parentId: null, type: 'custom', customType: 'doompi:context', data: { profile: 'test' } },
        ],
      },
    });
    emit({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'selection',
      statusText: 'newer live selection',
    });
    await ready;
    const frames = runtime.state.state.presentation?.projections.map((event) => event.frame);
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'entry_appended', entry: expect.objectContaining({ id: 'context' }) }),
    );
    expect(frames?.at(-1)).toMatchObject({ statusText: 'newer live selection' });
    emit({ type: 'extension_ui_request', method: 'confirm', id: 'dialog', title: 'confirm' });
    await runtime.extensionUiResponse({ id: 'dialog', confirmed: true }, BACKGROUND_CONTEXT);
    expect(runtime.state.state.presentation?.projections.some((event) => event.frame.id === 'dialog')).toBe(false);
    await runtime.dispose();
  });
  it('publishes custom-only hydration even when the transcript reducer has no change', async () => {
    const transcript = createRpcTranscript({ id: 's1', cwd: '/test', now: () => 0 });
    transcript.apply = () => ({});
    const { runtime, emit } = fixture(transcript);
    const publish = vi.spyOn(runtime.state, 'publish');
    emit({
      type: 'response',
      command: 'get_entries',
      success: true,
      data: {
        leafId: 'custom',
        entries: [{ id: 'custom', parentId: null, type: 'custom', customType: 'context', data: {} }],
      },
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(runtime.state.state.presentation?.projections).toHaveLength(1);
    emit({ type: 'response', command: 'get_entries', success: true, data: { entries: [], leafId: null } });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(runtime.state.state.presentation?.projections).toEqual([]);
    await runtime.dispose();
  });
  it('acknowledges browser preflight without binding the accepted turn to its caller lifetime', async () => {
    const { runtime, sent, emit } = fixture();
    const controller = new AbortController();
    const prompt = runtime.prompt(
      { text: 'background task', waitFor: 'accepted' },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    await expect(runtime.prompt({ text: 'duplicate', waitFor: 'accepted' }, BACKGROUND_CONTEXT)).rejects.toThrow(
      'already running',
    );
    expect(sent).toHaveLength(1);
    emit({ type: 'response', id: sent[0].id, command: 'prompt', success: true });
    await prompt;
    controller.abort();
    expect(sent.some((frame) => frame.type === 'abort')).toBe(false);
    emit({ type: 'agent_settled' });
    await runtime.dispose();
  });

  it('does not acknowledge rejected browser preflight as a successful submission', async () => {
    const { runtime, sent, emit } = fixture();
    const prompt = runtime.prompt({ text: 'task', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    emit({ type: 'response', id: sent[0].id, command: 'prompt', success: false, error: 'preflight denied' });
    await expect(prompt).rejects.toThrow('preflight denied');
    await runtime.dispose();
  });
  it('retains concurrent live items across unrelated frames for reconnecting clients', async () => {
    const { runtime, emit } = fixture();
    emit({ type: 'agent_start' });
    emit({
      type: 'message_start',
      message: { id: 'draft', role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    });
    emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: {} });
    emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'task', statusText: 'running' });
    expect(runtime.state.state.progress).toBeNull();
    expect(runtime.state.state.inFlight?.map((item) => item.id)).toEqual(['draft', 'tool']);
    emit({ type: 'tool_execution_end', toolCallId: 'tool', result: { content: [] }, isError: false });
    expect(runtime.state.state.inFlight?.map((item) => item.id)).toEqual(['draft']);
    emit({ type: 'agent_settled' });
    expect(runtime.state.state.inFlight).toEqual([]);
    await runtime.dispose();
  });
});
