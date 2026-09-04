import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
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
});
