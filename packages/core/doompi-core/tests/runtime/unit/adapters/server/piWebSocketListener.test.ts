import type { Server } from '@earendil-works/pi-server';
import { describe, expect, it, vi } from 'vitest';
import { createPiWebSocketListener, type PiListenerSocket } from '../../../../../src/pi/piWebSocketListener';

type ByteConnection = Parameters<Server['accept']>[0];

type SocketFixture = PiListenerSocket & {
  sent: Uint8Array[];
  closed: boolean;
};

function socket(options: { sendError?: Error; closeError?: Error; readyState?: number } = {}): SocketFixture {
  const fixture: SocketFixture = {
    sent: [],
    closed: false,
    readyState: options.readyState ?? 1,
    async send(data) {
      if (options.sendError) throw options.sendError;
      fixture.sent.push(new Uint8Array(data as ArrayBufferLike));
    },
    close() {
      fixture.closed = true;
      if (options.closeError) throw options.closeError;
    },
  };
  return fixture;
}

describe('createPiWebSocketListener', () => {
  it('rejects sockets before start and forwards bytes after start', async () => {
    const listener = createPiWebSocketListener();
    const early = socket();
    expect(listener.accept(early)).toBeUndefined();
    expect(early.closed).toBe(true);

    let connection: ByteConnection | undefined;
    const onData = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    await listener.start((accepted) => {
      connection = accepted;
      return { onData, onClose, onError };
    });
    const open = socket();
    const handler = listener.accept(open);
    expect(handler).toBeDefined();
    handler?.onData(new Uint8Array([1]));
    expect(onData).toHaveBeenCalledWith(new Uint8Array([1]));

    await connection?.send(new Uint8Array([2]));
    expect(open.sent).toEqual([new Uint8Array([2])]);
    await connection?.close(new Uint8Array([3]));
    expect(open.sent).toEqual([new Uint8Array([2]), new Uint8Array([3])]);
    expect(open.closed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    handler?.onClose();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports transport send errors and refuses a socket that is not open', async () => {
    const notice = vi.fn();
    const listener = createPiWebSocketListener({ onError: notice });
    let connection: ByteConnection | undefined;
    const onError = vi.fn();
    await listener.start((accepted) => {
      connection = accepted;
      return { onData: vi.fn(), onClose: vi.fn(), onError };
    });
    const failed = socket({ sendError: new Error('write failed') });
    listener.accept(failed);
    await expect(connection?.send(new Uint8Array([1]))).rejects.toThrow('write failed');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'write failed' })));
    expect(failed.closed).toBe(true);

    let closedConnection: ByteConnection | undefined;
    await listener.close();
    await listener.start((accepted) => {
      closedConnection = accepted;
      return { onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
    });
    listener.accept(socket({ readyState: 0 }));
    await expect(closedConnection?.send(new Uint8Array([1]))).rejects.toThrow('closed before send');
  });

  it('closes active sockets and reports close failures during listener shutdown', async () => {
    const notice = vi.fn();
    const listener = createPiWebSocketListener({ onError: notice });
    await listener.start(() => ({ onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() }));
    const failing = socket({ closeError: new Error('close failed') });
    listener.accept(failing);

    await listener.close();
    expect(failing.closed).toBe(true);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ message: 'close failed' }));
  });
});
