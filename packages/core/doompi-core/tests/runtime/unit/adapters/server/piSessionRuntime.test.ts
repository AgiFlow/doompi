import { spawn } from 'node:child_process';

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSessionRuntime } from '../../../../../src/pi/piSessionRuntime';
import type { ServerTelemetry } from '../../../../../src/services/serverTelemetry';
import type { DirectHarnessFrame, DirectHarnessRuntime } from '../../../../../src/types/server/directHarnessRuntime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function tracing(): ServerTelemetry {
  return {
    recordEvent: vi.fn(async () => undefined),
    recordWarning: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
    runInSpan: vi.fn(async (_name, _attributes, callback) => callback()),
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } as ServerTelemetry;
}

// A deadline is only a hang guard. Gates, not elapsed time, select each ordering.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('runtime regression timed out')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(telemetry?: ServerTelemetry) {
  const listeners = new Set<(frame: DirectHarnessFrame) => void>();
  let operation: { id: string; kind: 'run'; status: 'open' } | null = null;
  const exit = deferred<number>();
  const unsubscribe = vi.fn();
  const direct = {
    exited: exit.promise,
    onPresentationFrame(listener: (frame: DirectHarnessFrame) => void) {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
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
    setFastMode: vi.fn(async () => undefined),
    setAgentLock: vi.fn(async () => undefined),
    setSteeringMode: vi.fn(async () => undefined),
    setFollowUpMode: vi.fn(async () => undefined),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    navigateTree: vi.fn(async () => ({ cancelled: false, entries: [] })),
    submitPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
    submitUserPrompt: vi.fn(async () => ({ settled: Promise.resolve() })),
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
    exit,
    unsubscribe,
    respondToExtensionUi,
    emit(frame: DirectHarnessFrame) {
      if (frame.type === 'agent_start') operation = { id: 'op-1', kind: 'run', status: 'open' };
      if (frame.type === 'agent_settled') operation = null;
      for (const listener of listeners) listener(frame);
    },
  };
}

describe('typed session runtime controls', () => {
  it('validates session fast mode controls and projects the opt-in', async () => {
    const { direct, runtime } = fixture();
    expect((await runtime.getState(BACKGROUND_CONTEXT)).fastMode).toBe(false);
    await expect(runtime.setFastMode('on' as never, BACKGROUND_CONTEXT)).rejects.toThrow('Invalid fast mode');
    expect(direct.setFastMode).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(runtime.setFastMode(true, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow(
      'caller cancelled',
    );
    expect(direct.setFastMode).not.toHaveBeenCalled();
    await runtime.setFastMode(true, BACKGROUND_CONTEXT);
    expect(direct.setFastMode).toHaveBeenCalledWith(true);
    expect(runtime.state.value.snapshot.fastMode).toBe(true);
    vi.mocked(direct.setFastMode).mockRejectedValueOnce(new Error('Codex account unavailable'));
    await expect(runtime.setFastMode(false, BACKGROUND_CONTEXT)).rejects.toThrow('Codex account unavailable');
    expect(runtime.state.value.snapshot.fastMode).toBe(true);
    await runtime.dispose();
    await expect(runtime.setFastMode(false, BACKGROUND_CONTEXT)).rejects.toThrow('disposed');
  });
  it('projects the agent lock from frames and the control', async () => {
    const { direct, runtime, emit } = fixture();
    await expect(runtime.setAgentLock('on' as never, BACKGROUND_CONTEXT)).rejects.toThrow('Invalid agent lock');
    await runtime.setAgentLock(true, BACKGROUND_CONTEXT);
    expect(direct.setAgentLock).toHaveBeenCalledWith(true);
    expect(runtime.state.value.snapshot.locked).toBe(true);
    emit({ type: 'agent_start' });
    emit({ type: 'agent_settled' });
    expect(runtime.state.value.snapshot.locked).toBe(true);
    emit({ type: 'agent_lock_changed', locked: false });
    expect(runtime.state.value.snapshot.locked).toBe(false);
    await runtime.dispose();
  });
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

  it('projects durable stats without rereading or mutating the transcript', async () => {
    const { direct, runtime } = fixture();
    const stats = await direct.getSessionStats();
    vi.mocked(direct.getSessionStats).mockResolvedValue({
      ...stats,
      sessionFile: '/tmp/durable-v1/s1.sqlite',
      contextUsage: { tokens: 140, contextWindow: 1_000, percent: 14 },
    });
    await runtime.initialize();
    vi.mocked(direct.readState).mockClear();
    await expect(runtime.getSessionStats(BACKGROUND_CONTEXT)).resolves.toEqual({
      sessionId: 's1',
      sessionFile: '/tmp/durable-v1/s1.sqlite',
      totalMessages: 2,
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, total: 160 },
      cost: 0.34,
      contextUsage: { tokens: 140, contextWindow: 1_000, percent: 14 },
    });
    expect(direct.readEntries).not.toHaveBeenCalled();
    expect(direct.readState).not.toHaveBeenCalled();
    expect(direct.availableModels).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('pages from one snapshot without reversing shared history', async () => {
    const { direct, runtime } = fixture();
    const entries = Array.from({ length: 420 }, (_, index) => ({
      type: 'message' as const,
      id: `j${index}`,
      seq: index + 1,
      parentId: index === 0 ? null : `j${index - 1}`,
      timestamp: index,
      message: { role: 'user' as const, content: `line ${index}`, timestamp: index },
    }));
    vi.mocked(direct.readEntries).mockResolvedValue({ entries, leafId: 'j419' });
    try {
      const latest = await runtime.readTranscriptPage({}, BACKGROUND_CONTEXT);
      expect(latest.entries).toEqual(entries.slice(320));
      expect(entries[0]?.id).toBe('j0');
      expect(direct.readEntries).toHaveBeenCalledTimes(1);
      const older = await runtime.readTranscriptPage(
        { cursor: latest.olderCursor!, direction: 'older' },
        BACKGROUND_CONTEXT,
      );
      expect(older.entries).toEqual(entries.slice(220, 320));
      const newer = await runtime.readTranscriptPage(
        { cursor: older.newerCursor!, direction: 'newer' },
        BACKGROUND_CONTEXT,
      );
      expect(newer.entries).toEqual(latest.entries);
      expect(direct.readEntries).toHaveBeenCalledTimes(3);
      expect(entries[0]?.id).toBe('j0');
    } finally {
      await runtime.dispose();
    }
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
    expect(direct.submitPrompt).toHaveBeenCalledWith('hello', undefined, 'steer');
    let finished = false;
    void settled.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    emit({ type: 'agent_settled' });
    await settled;

    await runtime.prompt({ text: 'accepted', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(direct.submitPrompt).toHaveBeenLastCalledWith('accepted', undefined, 'steer');
    await runtime.dispose();
  });

  it.each(['/mode', '/domains', '/profile', '/minor'] as const)(
    'dispatches %s while a turn is running',
    async (command) => {
      const { direct, runtime, emit } = fixture();
      const active = runtime.prompt('active turn', BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledWith('active turn', undefined, 'steer'));
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

  it.each(['accepted', 'settled'] as const)('admits overlapping prompts with %s acknowledgement', async (waitFor) => {
    const { direct, runtime, emit } = fixture();
    const active = runtime.prompt('active turn', BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledOnce());
    emit({ type: 'agent_start' });
    const overlap = runtime.prompt({ text: 'ordinary text', waitFor }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledTimes(2));
    expect(direct.submitPrompt).toHaveBeenLastCalledWith('ordinary text', undefined, 'steer');
    if (waitFor === 'accepted') await overlap;
    expect(direct.abort).not.toHaveBeenCalled();
    emit({ type: 'agent_settled' });
    await Promise.all([active, overlap]);
    await runtime.dispose();
  });

  it('submits unrelated slash commands through native steer admission while busy', async () => {
    const f = fixture();
    f.emit({ type: 'agent_start' });
    vi.mocked(f.direct.submitPrompt).mockResolvedValueOnce({ settled: Promise.resolve(), handledCommand: true });
    await f.runtime.prompt('/run', BACKGROUND_CONTEXT);
    expect(f.direct.submitPrompt).toHaveBeenCalledWith('/run', undefined, 'steer');
    expect(f.direct.dispatchCommand).not.toHaveBeenCalled();
    expect(f.direct.abort).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });

  it('admits an idle prompt while an earlier receipt remains outstanding', async () => {
    const f = fixture();
    const firstEngine = deferred<void>();
    const ownEngine = deferred<void>();
    vi.mocked(f.direct.submitPrompt)
      .mockResolvedValueOnce({ settled: firstEngine.promise })
      .mockResolvedValueOnce({ settled: ownEngine.promise });
    const first = f.runtime.prompt('first', BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(f.direct.submitPrompt).toHaveBeenCalledOnce());
    const second = f.runtime.prompt('second', BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(f.direct.submitPrompt).toHaveBeenCalledTimes(2));
    f.emit({ type: 'agent_settled' });
    firstEngine.resolve();
    await first;
    let finished = false;
    void second.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    const third = f.runtime.prompt({ text: 'idle', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    await third;
    expect(f.direct.submitPrompt).toHaveBeenLastCalledWith('idle', undefined, 'steer');
    ownEngine.resolve();
    await second;
    await f.runtime.dispose();
  });

  it('does not report overlap admission against the original latency owner', async () => {
    const telemetry = tracing();
    const f = fixture(telemetry);
    const admission = deferred<Awaited<ReturnType<DirectHarnessRuntime['submitPrompt']>>>();
    vi.mocked(f.direct.submitPrompt).mockImplementationOnce(() => admission.promise);
    const first = f.runtime.prompt({ text: 'first', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(f.direct.submitPrompt).toHaveBeenCalledOnce());
    await f.runtime.prompt({ text: 'overlap', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
    expect(telemetry.recordEvent).not.toHaveBeenCalledWith(
      'doompi_server.prompt_latency',
      expect.objectContaining({ phase: 'accepted' }),
    );
    admission.resolve({ settled: Promise.resolve() });
    await first;
    expect(telemetry.recordEvent).toHaveBeenCalledWith(
      'doompi_server.prompt_latency',
      expect.objectContaining({ phase: 'accepted' }),
    );
    f.emit({ type: 'agent_settled' });
    await f.runtime.dispose();
  });

  it('does not abort the active turn when a selection command fails', async () => {
    const { direct, runtime, emit } = fixture();
    const active = runtime.prompt('active turn', BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(direct.submitPrompt).toHaveBeenCalledWith('active turn', undefined, 'steer'));
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
      await runtime.prompt({ text: 'overlapping', waitFor: 'accepted' }, BACKGROUND_CONTEXT);
      await runtime.steer(
        { text: 'steer', images: [{ type: 'image', data: 'data', mimeType: 'image/png' }] },
        BACKGROUND_CONTEXT,
      );
      await runtime.abort(BACKGROUND_CONTEXT);
      expect(direct.steer).toHaveBeenCalledWith('steer', [{ type: 'image', data: 'data', mimeType: 'image/png' }]);
      expect(direct.abort).toHaveBeenCalledWith('op-1');
      emit({ type: 'agent_settled' });
      await runtime.steer('idle', BACKGROUND_CONTEXT);
      expect(direct.steer).toHaveBeenCalledWith('idle', undefined);
      expect(direct.enqueueAutomatic).not.toHaveBeenCalled();
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

describe('deterministic prompt ownership regressions', () => {
  for (const waitFor of ['accepted', 'settled'] as const) {
    for (const telemetry of [false, true]) {
      for (const gate of ['lifecycle', 'admission'] as const) {
        for (const termination of ['exit', 'dispose'] as const) {
          it(`${waitFor}, telemetry ${telemetry}: ${termination} rejects before held ${gate}`, async () => {
            const f = fixture(telemetry ? tracing() : undefined);
            const lifecycle = deferred<Awaited<ReturnType<DirectHarnessRuntime['readLifecycle']>>>();
            const admission = deferred<Awaited<ReturnType<DirectHarnessRuntime['submitPrompt']>>>();
            const entered = deferred<void>();
            if (gate === 'lifecycle')
              vi.mocked(f.direct.readLifecycle).mockImplementationOnce(() => {
                entered.resolve();
                return lifecycle.promise;
              });
            else
              vi.mocked(f.direct.submitPrompt).mockImplementationOnce(() => {
                entered.resolve();
                return admission.promise;
              });
            const outcome = f.runtime.prompt({ text: 'held', waitFor }, BACKGROUND_CONTEXT).then(
              () => {
                throw new Error('prompt unexpectedly succeeded');
              },
              (error: unknown) => error,
            );
            try {
              await entered.promise;
              if (termination === 'exit') f.exit.resolve(0);
              else await f.runtime.dispose();
              expect(await bounded(outcome)).toBeInstanceOf(Error);
              expect(String(await outcome)).toContain(termination === 'exit' ? 'exited' : 'disposed');
            } finally {
              lifecycle.resolve({ revision: 0, operation: null, paused: false, queue: [] });
              admission.reject(new Error('late admission rejection'));
              // The unused gate has no runtime owner.
              if (gate === 'lifecycle') await admission.promise.catch(() => undefined);
              await f.runtime.dispose();
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            expect(f.unsubscribe).toHaveBeenCalledOnce();
            expect(f.direct.abort).not.toHaveBeenCalled();
            if (gate === 'lifecycle') expect(f.direct.submitPrompt).not.toHaveBeenCalled();
          });
        }
      }
      it(`${waitFor}, telemetry ${telemetry}: owns engine returned by late admission`, async () => {
        const f = fixture(telemetry ? tracing() : undefined);
        const admission = deferred<Awaited<ReturnType<DirectHarnessRuntime['submitPrompt']>>>();
        const engine = deferred<void>();
        const entered = deferred<void>();
        vi.mocked(f.direct.submitPrompt).mockImplementationOnce(() => {
          entered.resolve();
          return admission.promise;
        });
        const outcome = f.runtime
          .prompt({ text: 'late engine', waitFor }, BACKGROUND_CONTEXT)
          .catch((error: unknown) => error);
        try {
          await entered.promise;
          f.exit.resolve(0);
          expect(String(await bounded(outcome))).toContain('exited');
        } finally {
          admission.resolve({ settled: engine.promise });
          await new Promise<void>((resolve) => setImmediate(resolve));
          engine.reject(new Error('engine from late admission'));
          await new Promise<void>((resolve) => setImmediate(resolve));
          await f.runtime.dispose();
        }
      });
      it(`${waitFor}, telemetry ${telemetry}: owns late engine rejection after exit`, async () => {
        const f = fixture(telemetry ? tracing() : undefined);
        const engine = deferred<void>();
        const entered = deferred<void>();
        vi.mocked(f.direct.submitPrompt).mockImplementationOnce(async () => {
          entered.resolve();
          return { settled: engine.promise };
        });
        const pending = f.runtime.prompt({ text: 'engine', waitFor }, BACKGROUND_CONTEXT);
        const outcome = pending.then(
          () => undefined,
          (error: unknown) => error,
        );
        await entered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (waitFor === 'accepted') await pending;
        f.exit.resolve(0);
        if (waitFor === 'settled') expect(await bounded(outcome)).toBeInstanceOf(Error);
        engine.reject(new Error('late engine rejection'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await f.runtime.dispose();
        expect(f.unsubscribe).toHaveBeenCalledOnce();
      });
    }
  }

  it.each([false, true])('preserves original engine error after projection, telemetry %s', async (telemetry) => {
    const f = fixture(telemetry ? tracing() : undefined);
    const engine = deferred<void>();
    const failure = new Error('engine failed after projection');
    const entered = deferred<void>();
    vi.mocked(f.direct.submitPrompt).mockImplementationOnce(async () => {
      entered.resolve();
      return { settled: engine.promise };
    });
    const outcome = f.runtime.prompt('project first', BACKGROUND_CONTEXT).catch((error: unknown) => error);
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.emit({ type: 'agent_settled' });
    engine.reject(failure);
    expect(await bounded(outcome)).toBe(failure);
    await f.runtime.dispose();
  });

  it.each(['accepted', 'settled'] as const)(
    'owns outer telemetry rejection before callback for %s',
    async (waitFor) => {
      const telemetry = tracing();
      const failure = new Error('outer span failed');
      vi.mocked(telemetry.runInSpan).mockRejectedValueOnce(failure);
      const f = fixture(telemetry);
      const outcome = f.runtime
        .prompt({ text: 'never admitted', waitFor }, BACKGROUND_CONTEXT)
        .catch((error: unknown) => error);
      expect(await bounded(outcome)).toBe(failure);
      expect(f.direct.submitPrompt).not.toHaveBeenCalled();
      await f.runtime.dispose();
    },
  );

  it.each([
    { telemetry: false, late: 'reject' },
    { telemetry: true, late: 'reject' },
    { telemetry: false, late: 'resolve' },
    { telemetry: true, late: 'resolve' },
  ])('cancels held admission once, telemetry $telemetry, late $late', async ({ telemetry, late }) => {
    const f = fixture(telemetry ? tracing() : undefined);
    const admission = deferred<Awaited<ReturnType<DirectHarnessRuntime['submitPrompt']>>>();
    const entered = deferred<void>();
    vi.mocked(f.direct.submitPrompt).mockImplementationOnce(() => {
      entered.resolve();
      return admission.promise;
    });
    const controller = new AbortController();
    const outcome = f.runtime
      .prompt('cancel', withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
      .catch((error: unknown) => error);
    await entered.promise;
    controller.abort(new Error('caller cancelled'));
    expect(String(await bounded(outcome))).toContain('cancel');
    if (late === 'resolve') {
      const engine = deferred<void>();
      admission.resolve({ settled: engine.promise });
      await new Promise<void>((resolve) => setImmediate(resolve));
      engine.reject(new Error('late cancellation engine'));
    } else admission.reject(new Error('late cancellation admission'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.runtime.dispose();
    expect(f.direct.abort).toHaveBeenCalledOnce();
  });

  it.each(['accepted', 'settled'] as const)('preserves rejected runtime exit for %s', async (waitFor) => {
    const f = fixture(waitFor === 'accepted' ? tracing() : undefined);
    const admission = deferred<Awaited<ReturnType<DirectHarnessRuntime['submitPrompt']>>>();
    const entered = deferred<void>();
    const failure = new Error('runtime exit failed');
    vi.mocked(f.direct.submitPrompt).mockImplementationOnce(() => {
      entered.resolve();
      return admission.promise;
    });
    const outcome = f.runtime.prompt({ text: 'held', waitFor }, BACKGROUND_CONTEXT).catch((error: unknown) => error);
    try {
      await entered.promise;
      f.exit.reject(failure);
      expect(await bounded(outcome)).toBe(failure);
      await expect(f.runtime.getState(BACKGROUND_CONTEXT)).rejects.toThrow('disposed');
    } finally {
      admission.resolve({ settled: Promise.reject(new Error('late rejected-exit engine')) });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.runtime.dispose();
    }
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it.each(['exit-dispose', 'dispose-exit'] as const)('unsubscribes exactly once for %s', async (ordering) => {
    const f = fixture();
    if (ordering === 'dispose-exit') await f.runtime.dispose();
    f.exit.resolve(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.runtime.dispose();
    await f.runtime.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('strict Node built child owns late failures and keeps a sibling usable', async () => {
    const server = new URL('../../../../../dist/server.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import { createAgentSessionRuntime } from ${JSON.stringify(server)};
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
const deferred = () => { let resolve, reject; const promise = new Promise((y,n) => {resolve=y;reject=n}); return {promise,resolve,reject}; };
const tick = () => new Promise(r => setImmediate(r));
const telemetry = { recordEvent: async()=>{}, runInSpan: async(_n,_a,fn)=>fn() };
function fixture(trace) {
  const exit=deferred(), admission=deferred(), entered=deferred(); let listener, unsubscribed=0;
  const direct={exited:exit.promise, onPresentationFrame(fn){listener=fn;return ()=>{unsubscribed++;};},
    readState:async()=>({sessionId:'strict',fastMode:false}),
    readLifecycle:async()=>({revision:0,operation:null,paused:false,queue:[]}),
    submitPrompt:()=>{entered.resolve();return admission.promise;}, abort:async()=>{}};
  const runtime=createAgentSessionRuntime({runtime:direct,sessionId:'strict',sessionName:'strict',cwd:'/test',telemetry:trace});
  return {runtime,exit,admission,entered,emit:()=>listener({type:'agent_settled'}),count:()=>unsubscribed};
}
for (const mode of ['accepted','settled']) for (const trace of [undefined,telemetry]) {
  const f=fixture(trace), sibling=fixture();
  const outcome=f.runtime.prompt({text:'held',waitFor:mode},BACKGROUND_CONTEXT).then(()=>{throw Error('unexpected success');},e=>e);
  await f.entered.promise; f.exit.resolve(0);
  const error=await outcome; assert.match(error.message,/exited/);
  console.log('PUBLIC_REJECTION_BEFORE_RELEASE',mode,!!trace);
  f.admission.reject(Error('late admission')); await tick();
  const success=sibling.runtime.prompt('sibling',BACKGROUND_CONTEXT);
  await sibling.entered.promise; sibling.admission.resolve({settled:Promise.resolve()}); sibling.emit(); await success;
  await f.runtime.dispose(); await sibling.runtime.dispose(); assert.equal(f.count(),1);
  console.log('SIBLING_SUCCESS',mode,!!trace);
}
for (const mode of ['accepted','settled']) for (const trace of [undefined,telemetry]) {
 const f=fixture(trace), engine=deferred();
 const outcome=f.runtime.prompt({text:'engine',waitFor:mode},BACKGROUND_CONTEXT).catch(e=>e);
 await f.entered.promise; f.admission.resolve({settled:engine.promise}); await tick();
 if(mode==='accepted') await outcome;
 f.exit.resolve(0); if(mode==='settled') assert.match((await outcome).message,/exited/);
 engine.reject(Error('late engine')); await tick(); await f.runtime.dispose();
 console.log('LATE_ENGINE_OWNED',!!trace);
}
console.log('STRICT_COMPLETE');`;
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(code, stderr + stdout).toBe(0);
      expect(stdout.match(/PUBLIC_REJECTION_BEFORE_RELEASE/g)).toHaveLength(4);
      expect(stdout.match(/SIBLING_SUCCESS/g)).toHaveLength(4);
      expect(stdout.match(/LATE_ENGINE_OWNED/g)).toHaveLength(4);
      expect(stdout).toContain('STRICT_COMPLETE');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15_000);
});
