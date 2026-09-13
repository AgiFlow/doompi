import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { describe, expect, it, vi } from 'vitest';

import { createAgentServerService, createAgentSessionRuntime } from '../../../../../src/pi/piSessionRuntime';
import type { ServerTelemetry } from '../../../../../src/services/serverTelemetry';
import type { DirectHarnessFrame, DirectHarnessRuntime } from '../../../../../src/types/server/directHarnessRuntime';

function fixture(telemetry?: ServerTelemetry) {
  const listeners = new Set<(frame: DirectHarnessFrame) => void>();
  const direct = {
    exited: new Promise<number>(() => undefined),
    onPresentationFrame(listener: (frame: DirectHarnessFrame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readEntries: vi.fn(async () => ({ entries: [], leafId: null })),
    readState: vi.fn(async () => ({ sessionId: 's1', thinkingLevel: 'off' })),
    listCommands: vi.fn(() => [{ name: 'run', description: 'Run' }]),
    availableModels: vi.fn(async () => [{ provider: 'test', id: 'm', api: 'test' }]),
    availableThinkingLevels: vi.fn(async () => ['off', 'high']),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    setSteeringMode: vi.fn(async () => undefined),
    setFollowUpMode: vi.fn(async () => undefined),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    navigateTree: vi.fn(async () => ({ cancelled: false, entries: [] })),
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    setName: vi.fn(async () => undefined),
    getSessionStats: vi.fn(async () => ({
      messageCount: 2,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 160,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
      },
    })),
  } as unknown as DirectHarnessRuntime;
  Object.assign(direct, {
    sessionId: 's1',
    laneName: 'main',
    lane: {
      findEntries: vi.fn(async () => (await direct.readEntries()).entries.toReversed()),
      getTipId: vi.fn(async () => null),
    },
  });
  const respondToExtensionUi = vi.fn(() => true);
  const runtime = createAgentSessionRuntime({
    runtime: direct,
    sessionId: 's1',
    sessionName: 'test',
    cwd: '/test',
    respondToExtensionUi,
    telemetry,
  });
  return {
    direct,
    runtime,
    respondToExtensionUi,
    emit(frame: DirectHarnessFrame) {
      for (const listener of listeners) listener(frame);
    },
  };
}

describe('typed session runtime controls', () => {
  it('uses direct typed reads and model controls', async () => {
    const { direct, runtime } = fixture();

    await expect(runtime.getCommands(BACKGROUND_CONTEXT)).resolves.toEqual([{ name: 'run', description: 'Run' }]);
    await expect(runtime.getAvailableModels(BACKGROUND_CONTEXT)).resolves.toEqual([{ provider: 'test', id: 'm' }]);
    await expect(runtime.getAvailableThinkingLevels(BACKGROUND_CONTEXT)).resolves.toEqual(['off', 'high']);
    await expect(runtime.getState(BACKGROUND_CONTEXT)).resolves.toMatchObject({ sessionId: 's1' });
    await runtime.setModel({ provider: 'test', id: 'm' }, BACKGROUND_CONTEXT);
    await runtime.setThinking('high', BACKGROUND_CONTEXT);

    expect(direct.setModel).toHaveBeenCalledWith({ provider: 'test', id: 'm' });
    expect(direct.setThinkingLevel).toHaveBeenCalledWith('high');
    await runtime.dispose();
  });

  it('projects v4 storage usage into the client session stats contract', async () => {
    const { direct, runtime } = fixture();
    vi.mocked(direct.readState).mockResolvedValue({
      sessionId: 's1',
      sessionFile: '/tmp/s1.jsonl',
      model: { provider: 'test', id: 'm' },
    });
    vi.mocked(direct.availableModels).mockResolvedValue([{ provider: 'test', id: 'm', contextWindow: 1_000 } as never]);
    vi.mocked(direct.readEntries).mockResolvedValue({
      leafId: 'assistant',
      entries: [
        { type: 'message', id: 'user', message: { role: 'user', content: 'hello' } },
        {
          type: 'message',
          id: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            usage: {
              input: 100,
              output: 20,
              cacheRead: 30,
              cacheWrite: 10,
              totalTokens: 160,
              cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
            },
          },
        },
      ] as never,
    });

    await expect(runtime.getSessionStats(BACKGROUND_CONTEXT)).resolves.toEqual({
      sessionId: 's1',
      sessionFile: '/tmp/s1.jsonl',
      totalMessages: 2,
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, total: 160 },
      cost: 0.34,
      contextUsage: { tokens: 140, contextWindow: 1_000, percent: 14 },
    });
    await runtime.dispose();
  });

  it('forwards queue and rewind controls through direct methods', async () => {
    const { direct, runtime } = fixture();
    vi.mocked(direct.readEntries).mockResolvedValue({
      leafId: 'entry',
      entries: [
        {
          id: 'entry',
          parentId: null,
          type: 'message',
          seq: 1,
          timestamp: Date.now(),
          message: { role: 'user', timestamp: 123, content: 'hello' },
        },
      ],
    });

    await expect(runtime.clearQueue(BACKGROUND_CONTEXT)).resolves.toEqual({ steering: [], followUp: [] });
    await expect(runtime.rewind({ itemId: 'user-123', summarize: true }, BACKGROUND_CONTEXT)).resolves.toMatchObject({
      cancelled: false,
    });
    expect(direct.navigateTree).toHaveBeenCalledWith('entry', { summarize: true });
    await runtime.dispose();
  });

  it('preserves images and routes extension dialog responses to the host', async () => {
    const { direct, runtime, respondToExtensionUi } = fixture();
    const images = [{ type: 'image' as const, data: 'image', mimeType: 'image/png' }];

    await runtime.followUp({ text: 'later', images }, BACKGROUND_CONTEXT);
    await runtime.extensionUiResponse({ id: 'dialog-1', value: 'yes' }, BACKGROUND_CONTEXT);

    expect(direct.followUp).toHaveBeenCalledWith('later', images);
    expect(respondToExtensionUi).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'dialog-1', value: 'yes' });
    await runtime.dispose();
  });

  it('waits for settlement while accepted acknowledgement returns after direct admission', async () => {
    const { direct, runtime, emit } = fixture();

    const settled = runtime.prompt('hello', BACKGROUND_CONTEXT);
    await Promise.resolve();
    expect(direct.submitPrompt).toHaveBeenCalledWith('hello', undefined);
    let finished = false;
    void settled.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    emit({ type: 'agent_settled' });
    await settled;

    await runtime.prompt({ text: 'accepted', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(direct.submitPrompt).toHaveBeenLastCalledWith('accepted', undefined);
    await runtime.dispose();
  });

  it('releases command prompts without an agent settlement frame', async () => {
    const { direct, runtime } = fixture();
    vi.mocked(direct.submitPrompt).mockResolvedValue({ settled: Promise.resolve(), handledCommand: true });
    try {
      await runtime.prompt('/minor plan', BACKGROUND_CONTEXT);
      await runtime.prompt('/profile', BACKGROUND_CONTEXT);
      expect(direct.submitPrompt).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('releases accepted command prompts with telemetry enabled', async () => {
    const telemetry = {
      recordEvent: vi.fn(async () => undefined),
      recordWarning: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
      runInSpan: vi.fn(async (_name, _attributes, callback) => callback()),
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as ServerTelemetry;
    const { direct, runtime } = fixture(telemetry);
    vi.mocked(direct.submitPrompt).mockResolvedValue({ settled: Promise.resolve(), handledCommand: true });
    try {
      await runtime.prompt({ text: '/minor plan', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
      await runtime.prompt({ text: '/profile', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
      expect(direct.submitPrompt).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('records prompt latency stages and spans without delaying presentation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const telemetry = {
      recordEvent: vi.fn(async () => undefined),
      recordWarning: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
      runInSpan: vi.fn(async (_name, _attributes, callback) => callback()),
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as ServerTelemetry;
    const { runtime, emit } = fixture(telemetry);
    try {
      const pending = runtime.prompt('trace me', BACKGROUND_CONTEXT);
      await vi.advanceTimersByTimeAsync(10);
      emit({ type: 'agent_start' });
      await vi.advanceTimersByTimeAsync(20);
      emit({ type: 'message_start', message: { role: 'assistant' } });
      await vi.advanceTimersByTimeAsync(30);
      emit({ type: 'message_update', message: { role: 'assistant' } });
      await vi.advanceTimersByTimeAsync(40);
      emit({ type: 'message_end', message: { role: 'assistant' } });
      await vi.advanceTimersByTimeAsync(50);
      emit({ type: 'agent_settled' });
      await pending;

      expect(telemetry.runInSpan).toHaveBeenCalledWith(
        'doompi_server.prompt_to_settled',
        { session_id: 's1' },
        expect.any(Function),
      );
      expect(telemetry.runInSpan).toHaveBeenCalledWith(
        'doompi_server.prompt_admission',
        { session_id: 's1' },
        expect.any(Function),
      );
      expect(telemetry.runInSpan).toHaveBeenCalledWith(
        'doompi_server.prompt_engine_settlement',
        { session_id: 's1' },
        expect.any(Function),
      );
      expect(telemetry.runInSpan).toHaveBeenCalledWith(
        'doompi_server.prompt_projection_settlement',
        { session_id: 's1' },
        expect.any(Function),
      );
      expect(telemetry.recordEvent).toHaveBeenCalledWith(
        'doompi_server.prompt_latency',
        expect.objectContaining({ phase: 'first_response', duration_ms: 60 }),
      );
      expect(telemetry.recordEvent).toHaveBeenCalledWith(
        'doompi_server.prompt_latency',
        expect.objectContaining({ phase: 'settled', duration_ms: 150, stage_duration_ms: 50 }),
      );
    } finally {
      await runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('records accepted prompt latency through background settlement', async () => {
    const telemetry = {
      recordEvent: vi.fn(async () => undefined),
      recordWarning: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
      runInSpan: vi.fn(async (_name, _attributes, callback) => callback()),
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as ServerTelemetry;
    const { runtime, emit } = fixture(telemetry);
    try {
      await runtime.prompt({ text: 'accepted trace', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
      expect(telemetry.recordEvent).toHaveBeenCalledWith(
        'doompi_server.prompt_latency',
        expect.objectContaining({ phase: 'accepted' }),
      );

      emit({ type: 'agent_settled' });
      await vi.waitFor(() => {
        expect(telemetry.runInSpan).toHaveBeenCalledWith(
          'doompi_server.prompt_to_settled',
          { session_id: 's1' },
          expect.any(Function),
        );
        expect(telemetry.recordEvent).toHaveBeenCalledWith(
          'doompi_server.prompt_latency',
          expect.objectContaining({ phase: 'settled' }),
        );
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('times assistant messages and the gap after a tool result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const telemetry = {
      recordEvent: vi.fn(async () => undefined),
      recordWarning: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
      runInSpan: vi.fn(async (_name, _attributes, callback) => callback()),
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as ServerTelemetry;
    const { runtime, emit } = fixture(telemetry);
    try {
      const pending = runtime.prompt('trace a tool', BACKGROUND_CONTEXT);
      await vi.advanceTimersByTimeAsync(10);
      emit({ type: 'message_start', message: { role: 'assistant' } });
      await vi.advanceTimersByTimeAsync(20);
      emit({ type: 'message_end', message: { role: 'assistant' } });
      emit({ type: 'message_end', message: { role: 'toolResult' } });
      await vi.advanceTimersByTimeAsync(50);
      emit({ type: 'message_start', message: { role: 'assistant' } });
      await vi.advanceTimersByTimeAsync(30);
      emit({ type: 'message_end', message: { role: 'assistant' } });
      emit({ type: 'agent_settled' });
      await pending;

      expect(telemetry.recordEvent).toHaveBeenCalledWith('doompi_server.tool_result_to_response', {
        session_id: 's1',
        duration_ms: 50,
      });
      expect(telemetry.recordEvent).toHaveBeenCalledWith('doompi_server.assistant_message', {
        session_id: 's1',
        duration_ms: 20,
      });
      expect(telemetry.recordEvent).toHaveBeenCalledWith('doompi_server.assistant_message', {
        session_id: 's1',
        duration_ms: 30,
      });
    } finally {
      await runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('aborts the active direct turn when the caller cancels', async () => {
    const { direct, runtime } = fixture();
    const controller = new AbortController();
    const pending = runtime.prompt('cancel me', withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    await Promise.resolve();
    controller.abort(new Error('cancelled'));

    await expect(pending).rejects.toThrow('cancelled');
    expect(direct.abort).toHaveBeenCalledOnce();
    await runtime.dispose();
  });
  it('rejects malformed controls and prevents operations after disposal', async () => {
    const { direct, runtime, emit, respondToExtensionUi } = fixture();
    try {
      await expect(runtime.prompt({ text: 42 } as never, BACKGROUND_CONTEXT)).rejects.toThrow(
        'Prompt message must be a string',
      );
      await expect(
        runtime.prompt({ text: 'bad images', images: [{ type: 'text' }] } as never, BACKGROUND_CONTEXT),
      ).rejects.toThrow('Invalid message images');
      await expect(
        runtime.prompt({ text: 'bad acknowledgement', waitFor: 'queued' } as never, BACKGROUND_CONTEXT),
      ).rejects.toThrow('Invalid prompt acknowledgement mode');

      emit({ type: 'agent_start' });
      await expect(runtime.prompt('overlapping', BACKGROUND_CONTEXT)).rejects.toThrow('A turn is already running');
      await runtime.steer(
        { text: 'steer', images: [{ type: 'image', data: 'data', mimeType: 'image/png' }] },
        BACKGROUND_CONTEXT,
      );
      await runtime.abort(BACKGROUND_CONTEXT);
      expect(direct.steer).toHaveBeenCalledWith('steer', [{ type: 'image', data: 'data', mimeType: 'image/png' }]);
      expect(direct.abort).toHaveBeenCalledOnce();
      emit({ type: 'agent_settled' });
      await expect(runtime.steer('idle', BACKGROUND_CONTEXT)).rejects.toThrow('There is no active turn to steer');
      await expect(runtime.abort(BACKGROUND_CONTEXT)).rejects.toThrow('There is no active turn to abort');

      await expect(runtime.setModel(null as never, BACKGROUND_CONTEXT)).rejects.toThrow('Invalid model');
      await expect(runtime.setThinking('invalid' as never, BACKGROUND_CONTEXT)).rejects.toThrow(
        'Invalid thinking level',
      );
      await expect(runtime.setName('x'.repeat(257), BACKGROUND_CONTEXT)).rejects.toThrow('Invalid session name');
      await expect(runtime.rewind(null as never, BACKGROUND_CONTEXT)).rejects.toThrow('Invalid rewind identity');
      await expect(runtime.rewind({ itemId: 'missing' }, BACKGROUND_CONTEXT)).rejects.toThrow(
        'selected message is not in the active session tree',
      );

      await expect(runtime.extensionUiResponse({ id: '', value: 'yes' }, BACKGROUND_CONTEXT)).rejects.toThrow(
        'Invalid extension UI response',
      );
      await expect(
        runtime.extensionUiResponse({ id: 'dialog', value: 42 } as never, BACKGROUND_CONTEXT),
      ).rejects.toThrow('Invalid extension UI response');
      await runtime.extensionUiResponse({ id: 'dialog', confirmed: true }, BACKGROUND_CONTEXT);
      vi.mocked(respondToExtensionUi).mockReturnValue(false);
      await expect(runtime.extensionUiResponse({ id: 'missing', cancelled: true }, BACKGROUND_CONTEXT)).rejects.toThrow(
        'No pending extension UI request',
      );

      await runtime.dispose();
      await expect(runtime.getState(BACKGROUND_CONTEXT)).rejects.toThrow('session runtime is disposed');
      await expect(runtime.prompt('after disposal', BACKGROUND_CONTEXT)).rejects.toThrow('session runtime is disposed');
    } finally {
      await runtime.dispose();
    }
  });
  it('initializes without loading history and propagates prompt admission failures', async () => {
    const { direct, runtime } = fixture();
    vi.mocked(direct.readEntries).mockResolvedValue({
      leafId: null,
      entries: [{ type: 'custom', customType: 'persisted', data: { value: true } } as never],
    });
    vi.mocked(direct.submitPrompt).mockRejectedValueOnce(new Error('prompt admission failed'));
    try {
      await runtime.initialize();
      await runtime.initialize();
      expect(direct.readEntries).not.toHaveBeenCalled();
      await expect(runtime.prompt('will fail', BACKGROUND_CONTEXT)).rejects.toThrow('prompt admission failed');
    } finally {
      await runtime.dispose();
    }
  });
  it('allows only one presentation to attach to a supervised session', async () => {
    const { direct } = fixture();
    const host = createAgentServerService({
      runtime: direct,
      sessionId: 's1',
      sessionName: 'test',
      cwd: '/test',
      createdAt: 1,
    });
    const metadata = await host.resolveSession('s1', BACKGROUND_CONTEXT);
    const handle = await host.openSession(metadata, BACKGROUND_CONTEXT);
    const first = await handle.attachClient(BACKGROUND_CONTEXT);

    await expect(Promise.resolve().then(() => handle.attachClient(BACKGROUND_CONTEXT))).rejects.toThrow(
      'session already attached',
    );

    await first.release(BACKGROUND_CONTEXT);
    const replacement = await handle.attachClient(BACKGROUND_CONTEXT);
    await replacement.release(BACKGROUND_CONTEXT);
    await handle.close(BACKGROUND_CONTEXT);
  });
});
