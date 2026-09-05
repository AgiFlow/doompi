import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createComputerUseIpcBinding, type IpcProcess } from '../../src/adapters/computerUseIpc.ts';

class FakeIpcProcess extends EventEmitter {
  connected = true;
  readonly sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

function createBinding(child: FakeIpcProcess) {
  return createComputerUseIpcBinding(child as unknown as IpcProcess);
}
describe('computer-use Desktop IPC binding', () => {
  it('is absent without an authenticated parent-child IPC channel', () => {
    const child = new FakeIpcProcess();
    child.connected = false;
    expect(createBinding(child)).toBeUndefined();
  });

  it('correlates one session-scoped request and response', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child);
    expect(binding).toBeDefined();

    const pending = binding?.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'status' });
    const sent = child.sent[0] as { requestId: string; sessionId: string };
    expect(sent.sessionId).toBe('session-a');

    child.emit('message', {
      type: 'doompi:computer-use:response',
      version: 1,
      requestId: sent.requestId,
      ok: true,
      result: { available: true },
    });

    await expect(pending).resolves.toEqual({ available: true });
    binding?.close?.();
    expect(child.sent.at(-1)).toEqual({ type: 'doompi:computer-use:close', version: 1 });
  });

  it('rejects pending requests when the Desktop parent disconnects', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child);
    const pending = binding?.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'targets' });

    child.connected = false;
    child.emit('disconnect');
    await expect(pending).rejects.toThrow(/disconnected/u);
  });

  it('forwards cancellation to the Desktop parent', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child);
    const controller = new AbortController();
    const pending = binding?.request(
      { sessionId: 'session-a', cwd: '/workspace' },
      { operation: 'targets', signal: controller.signal },
    );
    const requestId = (child.sent[0] as { requestId: string }).requestId;

    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/u);
    expect(child.sent.at(-1)).toEqual({ type: 'doompi:computer-use:cancel', version: 1, requestId });
  });
  it('requires a send function even when the IPC channel is connected', () => {
    const child = new FakeIpcProcess();
    Object.assign(child, { send: undefined });
    expect(createBinding(child)).toBeUndefined();
  });

  it.each([
    ['provided', 'Permission denied', 'Permission denied'],
    ['omitted', undefined, 'Desktop computer use failed.'],
  ])('rejects a Desktop failure with its %s error', async (_label, error, expected) => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    try {
      const pending = binding.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'status' });
      const { requestId } = child.sent[0] as { requestId: string };
      child.emit('message', { type: 'doompi:computer-use:response', version: 1, requestId, ok: false, error });
      await expect(pending).rejects.toThrow(expected);
    } finally {
      binding.close?.();
    }
  });

  it('ignores malformed, oversized, unserializable and unrelated responses', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    try {
      const pending = binding.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'status' });
      const { requestId } = child.sent[0] as { requestId: string };
      const response = { type: 'doompi:computer-use:response', version: 1, requestId, ok: true, result: 'ready' };
      const settled = vi.fn();
      void pending.then(settled);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      for (const value of [
        undefined,
        null,
        42,
        [],
        circular,
        { ...response, type: 'other' },
        { ...response, version: 2 },
        { ...response, requestId: 42 },
        { ...response, ok: 'true' },
        { ...response, requestId: 'unknown' },
        { ...response, result: 'x'.repeat(8 * 1024 * 1024) },
      ])
        child.emit('message', value);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      child.emit('message', response);
      await expect(pending).resolves.toBe('ready');
      child.emit('message', { ...response, ok: false, error: 'late failure' });
      expect(settled).toHaveBeenCalledExactlyOnceWith('ready');
    } finally {
      binding.close?.();
    }
  });

  it('forwards payload without exposing the workspace path', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    try {
      const payload = { targetId: 'screen-1' };
      const pending = binding.request(
        { sessionId: 'session-a', cwd: '/private/workspace' },
        { operation: 'status', payload },
      );
      const { requestId } = child.sent[0] as { requestId: string };
      expect(child.sent[0]).toEqual({
        type: 'doompi:computer-use:request',
        version: 1,
        requestId,
        sessionId: 'session-a',
        operation: 'status',
        payload,
      });
      child.emit('message', { type: 'doompi:computer-use:response', version: 1, requestId, ok: true });
      await expect(pending).resolves.toBeUndefined();
    } finally {
      binding.close?.();
    }
  });

  it('rejects oversized and unserializable payloads without sending a request', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    try {
      for (const payload of [{ text: 'x'.repeat(8 * 1024 * 1024) }, circular]) {
        await expect(
          binding.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'status', payload }),
        ).rejects.toThrow('too large');
      }
      expect(child.sent).toEqual([]);
    } finally {
      binding.close?.();
    }
  });

  it('rejects an already aborted request without sending it', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    try {
      await expect(
        binding.request(
          { sessionId: 'session-a', cwd: '/workspace' },
          { operation: 'status', signal: AbortSignal.abort() },
        ),
      ).rejects.toThrow('cancelled');
      expect(child.sent).toEqual([{ type: 'doompi:computer-use:cancel', version: 1, requestId: expect.any(String) }]);
    } finally {
      binding.close?.();
    }
  });

  it('rejects failed sends and removes their abort listener', async () => {
    const child = new FakeIpcProcess();
    vi.spyOn(child, 'send').mockImplementation((_message, callback) => {
      callback?.(new Error('IPC write failed'));
      return false;
    });
    const binding = createBinding(child)!;
    const controller = new AbortController();
    try {
      await expect(
        binding.request(
          { sessionId: 'session-a', cwd: '/workspace' },
          { operation: 'status', signal: controller.signal },
        ),
      ).rejects.toThrow('IPC write failed');
      controller.abort();
      expect(child.send).toHaveBeenCalledTimes(1);
    } finally {
      binding.close?.();
    }
  });

  it.each([true, false])('times out a request when the channel connected state is %s', async (connected) => {
    vi.useFakeTimers();
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    try {
      const pending = binding.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'status' });
      const rejected = expect(pending).rejects.toThrow('timed out');
      child.connected = connected;
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(child.sent).toHaveLength(connected ? 2 : 1);
      if (connected)
        expect(child.sent[1]).toEqual({
          type: 'doompi:computer-use:cancel',
          version: 1,
          requestId: (child.sent[0] as { requestId: string }).requestId,
        });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      binding.close?.();
      vi.useRealTimers();
    }
  });

  it('bounds pending requests and accepts another after one completes', async () => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    const scope = { sessionId: 'session-a', cwd: '/workspace' };
    const pending = Array.from({ length: 128 }, () => binding.request(scope, { operation: 'status' }));
    const outcomes = Promise.allSettled(pending);
    try {
      await expect(binding.request(scope, { operation: 'status' })).rejects.toThrow('Too many pending');
      expect(child.sent).toHaveLength(128);
      const { requestId } = child.sent[0] as { requestId: string };
      child.emit('message', { type: 'doompi:computer-use:response', version: 1, requestId, ok: true, result: 'ready' });
      await expect(pending[0]).resolves.toBe('ready');
      const next = binding.request(scope, { operation: 'status' });
      const rejected = expect(next).rejects.toThrow('disconnected');
      expect(child.sent).toHaveLength(129);
      binding.close?.();
      await rejected;
      const results = await outcomes;
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(127);
    } finally {
      binding.close?.();
      await outcomes;
    }
  });

  it.each(['closed', 'disconnected', 'missing send'] as const)('rejects new requests when %s', async (state) => {
    const child = new FakeIpcProcess();
    const binding = createBinding(child)!;
    try {
      if (state === 'closed') {
        binding.close?.();
        binding.close?.();
        expect(child.sent).toHaveLength(1);
        expect(child.listenerCount('message')).toBe(0);
        expect(child.listenerCount('disconnect')).toBe(0);
      } else if (state === 'disconnected') child.connected = false;
      else Object.assign(child, { send: undefined });
      await expect(
        binding.request({ sessionId: 'session-a', cwd: '/workspace' }, { operation: 'status' }),
      ).rejects.toThrow('unavailable');
    } finally {
      binding.close?.();
    }
  });
});
