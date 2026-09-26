import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSessionRuntime } from '../../../../../src/pi/piSessionRuntime';
import type { ServerTelemetry } from '../../../../../src/services/serverTelemetry';
import type { DirectHarnessFrame, DirectHarnessRuntime } from '../../../../../src/types/server/directHarnessRuntime';

function fixture(telemetry?: ServerTelemetry) {
  const listeners = new Set<(frame: DirectHarnessFrame) => void>();
  let operation: { id: string; kind: 'run'; status: 'open' } | null = null;
  const direct = {
    exited: new Promise<number>(() => undefined),
    onPresentationFrame(listener: (frame: DirectHarnessFrame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readEntries: vi.fn(async () => ({ entries: [], leafId: null })),
    readState: vi.fn(async () => ({ sessionId: 's1', thinkingLevel: 'off' })),
    readLifecycle: vi.fn(async () => ({ operation, paused: false, revision: 0, queue: [] })),
    enqueueAutomatic: vi.fn(async () => ({ id: 'queue-1' })),
    removeQueued: vi.fn(async () => 'removed'),
    promoteQueued: vi.fn(async () => 'promoted'),
    resumeQueue: vi.fn(async () => undefined),
    listCommands: vi.fn(() => [{ name: 'run', description: 'Run' }]),
    dispatchCommand: vi.fn(async () => false),
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
      if (frame.type === 'agent_start') operation = { id: 'op-1', kind: 'run', status: 'open' };
      if (frame.type === 'agent_settled') operation = null;
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

  it('publishes native lifecycle independently of presentation phase and targets queue operations', async () => {
    const { direct, runtime, emit } = fixture();
    const active = {
      revision: 4,
      operation: { id: 'op-4', kind: 'run' as const, status: 'open' as const },
      paused: false,
      queue: [{ id: 'item-1', text: 'later', delivery: 'followUp', scheduling: 'automatic', disposition: 'pending' }],
    } as const;
    vi.mocked(direct.readLifecycle).mockResolvedValue(active as never);
    await runtime.initialize();
    expect(runtime.state.value.snapshot.lifecycle).toEqual(active);
    // Presentation compaction/idle transitions must not hide an owned native operation.
    emit({ type: 'compaction_end' });
    expect(runtime.state.value.snapshot.lifecycle?.operation?.id).toBe('op-4');
    await runtime.steer('change course', BACKGROUND_CONTEXT);
    await runtime.abortOperation({ operationId: 'op-4' }, BACKGROUND_CONTEXT);
    expect(direct.steer).toHaveBeenCalledWith('change course', undefined);
    expect(direct.abort).toHaveBeenCalledWith('op-4');

    await expect(runtime.enqueueAutomatic({ text: 'next' }, BACKGROUND_CONTEXT)).resolves.toEqual({ id: 'queue-1' });
    await expect(runtime.removeQueued({ id: 'item-1' }, BACKGROUND_CONTEXT)).resolves.toBe('removed');
    await expect(runtime.promoteQueued({ id: 'item-1', operationId: 'op-4' }, BACKGROUND_CONTEXT)).resolves.toBe(
      'promoted',
    );
    await runtime.resumeQueue(BACKGROUND_CONTEXT);
    expect(direct.enqueueAutomatic).toHaveBeenCalledWith('next', undefined);
    expect(direct.removeQueued).toHaveBeenCalledWith('item-1');
    expect(direct.promoteQueued).toHaveBeenCalledWith('item-1', 'op-4');
    expect(direct.resumeQueue).toHaveBeenCalledOnce();

    const aborting = { ...active, operation: { ...active.operation, status: 'aborting' as const } };
    emit({ type: 'lifecycle_update', lifecycle: aborting });
    expect(runtime.state.value.snapshot.lifecycle?.operation?.status).toBe('aborting');
    emit({ type: 'agent_settled' });
    expect(runtime.state.value.snapshot.lifecycle?.operation?.status).toBe('aborting');
    await runtime.dispose();
  });

  it('does not let delayed hydration or an old lifecycle event hide a newer turn', async () => {
    const { direct, runtime, emit } = fixture();
    let resolveInitial!: (value: unknown) => void;
    vi.mocked(direct.readLifecycle).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }) as never,
    );
    const initialization = runtime.initialize();
    const current = { revision: 2, operation: { id: 'new', kind: 'run', status: 'open' }, paused: false, queue: [] };
    emit({ type: 'lifecycle_update', lifecycle: current });
    resolveInitial({ revision: 1, operation: null, paused: false, queue: [] });
    await initialization;
    emit({ type: 'lifecycle_update', lifecycle: { revision: 1, operation: null, paused: false, queue: [] } });
    expect(runtime.state.value.snapshot.lifecycle?.operation?.id).toBe('new');
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

  it.each(['/mode', '/domains', '/profile', '/minor'] as const)(
    'dispatches %s while a turn is running',
    async (command) => {
      const { direct, runtime, emit } = fixture();
      const active = runtime.prompt('active turn', BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledWith('active turn', undefined));
      emit({ type: 'agent_start' });
      vi.mocked(direct.dispatchCommand).mockResolvedValueOnce(true);

      await expect(runtime.prompt(`${command} value`, BACKGROUND_CONTEXT)).resolves.toBeUndefined();
      expect(direct.dispatchCommand).toHaveBeenCalledWith(`${command} value`);
      expect(direct.submitPrompt).toHaveBeenCalledOnce();
      expect(direct.abort).not.toHaveBeenCalled();

      let finished = false;
      void active.then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      emit({ type: 'agent_settled' });
      await active;
      await runtime.dispose();
    },
  );

  it('keeps ordinary and unrelated commands blocked during a turn', async () => {
    const { direct, runtime, emit } = fixture();
    const active = runtime.prompt('active turn', BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledWith('active turn', undefined));
    emit({ type: 'agent_start' });

    await expect(runtime.prompt('/run', BACKGROUND_CONTEXT)).rejects.toThrow('A turn is already running');
    await expect(runtime.prompt('ordinary text', BACKGROUND_CONTEXT)).rejects.toThrow('A turn is already running');
    expect(direct.dispatchCommand).not.toHaveBeenCalled();

    emit({ type: 'agent_settled' });
    await active;
    await runtime.dispose();
  });

  it('does not abort the active turn when a selection command fails', async () => {
    const { direct, runtime, emit } = fixture();
    const active = runtime.prompt('active turn', BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledWith('active turn', undefined));
    emit({ type: 'agent_start' });
    vi.mocked(direct.dispatchCommand).mockRejectedValueOnce(new Error('selection failed'));

    await expect(runtime.prompt('/mode value', BACKGROUND_CONTEXT)).rejects.toThrow('selection failed');
    expect(direct.abort).not.toHaveBeenCalled();
    emit({ type: 'agent_settled' });
    await active;
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
      expect(direct.abort).toHaveBeenCalledWith('op-1');
      emit({ type: 'agent_settled' });
      await runtime.steer('idle', BACKGROUND_CONTEXT);
      expect(direct.enqueueAutomatic).toHaveBeenCalledWith('idle', undefined);
      await expect(runtime.abort(BACKGROUND_CONTEXT)).resolves.toBeUndefined();

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
});
