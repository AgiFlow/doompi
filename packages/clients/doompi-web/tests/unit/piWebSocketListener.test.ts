import type { Server } from '@earendil-works/pi-server';
import { describe, expect, it, vi } from 'vitest';
import { createPiWebSocketListener } from '../../src/adapters/piWebSocketListener.ts';

type Connection = Parameters<Server['accept']>[0];
const socket = (readyState?: number) => ({ send: vi.fn(), close: vi.fn(), readyState });

async function setup(readyState?: number) {
  const listener = createPiWebSocketListener();
  const transport = socket(readyState);
  const handler = { onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
  let connection!: Connection;
  await listener.start((value) => {
    connection = value;
    return handler;
  });
  const accepted = listener.accept(transport)!;
  return { listener, transport, handler, connection, accepted };
}

describe('Pi WebSocket byte listener', () => {
  it('rejects sockets before startup and after shutdown', async () => {
    const listener = createPiWebSocketListener();
    const before = socket();
    expect(listener.accept(before)).toBeUndefined();
    expect(before.close).toHaveBeenCalledOnce();
    await listener.start(() => ({ onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() }));
    await listener.close();
    const after = socket();
    expect(listener.accept(after)).toBeUndefined();
    expect(after.close).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, false],
    [1, false],
    [0, true],
    [2, true],
    [3, true],
  ] as const)('reflects socket readyState %s as closed=%s', async (readyState, expected) => {
    const { connection, listener } = await setup(readyState);
    expect(connection.closed).toBe(expected);
    await listener.close();
  });

  it.each([undefined, new Uint8Array([9])])('sends final bytes only when provided: %s', async (finalChunk) => {
    const { connection, transport, listener } = await setup();
    const chunk = new Uint8Array([1, 2]);
    await connection.send(chunk);
    await connection.close(finalChunk);
    expect(connection.closed).toBe(true);
    expect(transport.send.mock.calls).toEqual(finalChunk ? [[chunk], [finalChunk]] : [[chunk]]);
    await listener.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it.each(['onClose', 'onError'] as const)(
    'forwards %s and removes the socket from shutdown tracking',
    async (event) => {
      const { accepted, handler, connection, transport, listener } = await setup(1);
      const chunk = new Uint8Array([4]);
      accepted.onData(chunk);
      expect(handler.onData).toHaveBeenCalledWith(chunk);
      const error = new Error('socket failed');
      if (event === 'onError') {
        accepted.onError(error);
        expect(handler.onError).toHaveBeenCalledWith(error);
      } else {
        accepted.onClose();
        expect(handler.onClose).toHaveBeenCalledOnce();
      }
      expect(connection.closed).toBe(true);
      await listener.close();
      expect(transport.close).not.toHaveBeenCalled();
    },
  );

  it.each([new Error('close failed'), 'close failed'])(
    'continues shutdown after a socket throws: %s',
    async (error) => {
      const onError = vi.fn();
      const listener = createPiWebSocketListener({ onError });
      await listener.start(() => ({ onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() }));
      const broken = socket();
      broken.close.mockImplementation(() => {
        throw error;
      });
      const healthy = socket();
      listener.accept(broken);
      listener.accept(healthy);
      await listener.close();
      expect(onError).toHaveBeenCalledWith(error instanceof Error ? error : new Error(error));
      expect(healthy.close).toHaveBeenCalledOnce();
      await listener.close();
      expect(broken.close).toHaveBeenCalledOnce();
    },
  );

  it('tolerates shutdown errors without an error observer', async () => {
    const { listener, transport } = await setup();
    transport.close.mockImplementation(() => {
      throw new Error('already gone');
    });
    await expect(listener.close()).resolves.toBeUndefined();
  });
});
