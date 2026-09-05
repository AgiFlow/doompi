import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { attachComputerUseHostBridge } from '../../src/adapters/computerUseHostBridge.ts';
import { ComputerUseHost } from '../../src/services/computerUseHost.ts';
import type { ComputerUseBackend } from '../../src/types/computerUse.ts';

class FakeChild extends EventEmitter {
  readonly sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

function backendFixture() {
  let activationSignal: AbortSignal | undefined;
  const backend: ComputerUseBackend = {
    status: vi.fn(async () => ({})),
    targets: vi.fn(async () => []),
    activate: vi.fn(async (input) => {
      activationSignal = input.signal;
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }),
    observe: vi.fn(async () => ({})),
    act: vi.fn(async () => ({})),
    stop: vi.fn(async () => undefined),
  };
  const host = new ComputerUseHost({
    backend,
    hostGeneration: 'host-1',
    now: Date.now,
    newId: () => crypto.randomUUID(),
    confirmLocalActivation: async () => true,
  });
  return { host, activationSignal: () => activationSignal };
}

describe('computer-use host bridge', () => {
  it('forwards cancellation to an in-flight Desktop operation', async () => {
    const child = new FakeChild();
    const { host, activationSignal } = backendFixture();
    const bridge = attachComputerUseHostBridge(child as never, host);
    const now = Date.now();
    child.emit('message', {
      type: 'doompi:computer-use:request',
      version: 1,
      requestId: 'request-1',
      sessionId: 'session-1',
      operation: 'activate',
      payload: {
        requestId: 'confirmation-1',
        target: {
          bundleId: 'com.example.fixture',
          applicationName: 'Fixture',
          processId: 123,
          windowId: 'window-1',
          windowTitle: 'Fixture Window',
        },
        durationSeconds: 60,
        createdAt: now,
        confirmationExpiresAt: now + 120_000,
        caller: { locality: 'local', stepUp: 'not-required' },
      },
    });
    await vi.waitFor(() => expect(activationSignal()).toBeDefined());

    child.emit('message', { type: 'doompi:computer-use:cancel', version: 1, requestId: 'request-1' });

    await vi.waitFor(() => expect(activationSignal()?.aborted).toBe(true));
    await bridge.close();
  });
});
