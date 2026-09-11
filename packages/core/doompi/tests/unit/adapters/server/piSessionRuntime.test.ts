import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { describe, expect, it, vi } from 'vitest';
import { createAgentSessionRuntime } from '../../../../src/adapters/server/piSessionRuntime.ts';
import type { DirectHarnessFrame, DirectHarnessRuntime } from '../../../../src/types/server/directHarnessRuntime.ts';

function fixture() {
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
    getSessionStats: vi.fn(async () => ({ messages: 0 })),
  } as unknown as DirectHarnessRuntime;
  const respondToExtensionUi = vi.fn(() => true);
  const runtime = createAgentSessionRuntime({
    runtime: direct,
    sessionId: 's1',
    sessionName: 'test',
    cwd: '/test',
    respondToExtensionUi,
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
  it('hydrates persisted custom entries once and propagates prompt admission failures', async () => {
    const { direct, runtime } = fixture();
    vi.mocked(direct.readEntries).mockResolvedValue({
      leafId: null,
      entries: [{ type: 'custom', customType: 'persisted', data: { value: true } } as never],
    });
    vi.mocked(direct.submitPrompt).mockRejectedValueOnce(new Error('prompt admission failed'));
    try {
      await runtime.initialize();
      await runtime.initialize();
      expect(direct.readEntries).toHaveBeenCalledOnce();
      await expect(runtime.prompt('will fail', BACKGROUND_CONTEXT)).rejects.toThrow('prompt admission failed');
    } finally {
      await runtime.dispose();
    }
  });
});
