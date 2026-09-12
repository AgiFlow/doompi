import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtocolTransport, protocolSocketUrl } from '../../src/web/lib/piTransport';
import { sealedProtocolSession } from '../../src/web/lib/sealedSession';

type Listener = (event: unknown) => void;

/** A WebSocket the test drives, standing in for the browser's. */
class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = '';
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  fire(type: string, event: unknown = {}): void {
    // Copied: a listener may remove itself while being dispatched.
    for (const listener of (this.listeners.get(type) ?? []).slice()) listener(event);
  }
}

const handlers = () => ({ onData: vi.fn(), onClose: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  FakeSocket.last = undefined;
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  const sink = handlers();
  const connecting = createProtocolTransport('ws://cockpit/api/pi')(sink);
  FakeSocket.last?.fire('open');
  return { transport: await connecting, socket: FakeSocket.last as FakeSocket, sink };
}

describe('protocolSocketUrl', () => {
  it('follows the page scheme so a served cockpit is not downgraded', () => {
    expect(protocolSocketUrl({ protocol: 'https:', host: 'box:7433' } as Location)).toBe('wss://box:7433/api/pi');
    expect(protocolSocketUrl({ protocol: 'http:', host: '127.0.0.1:7433' } as Location)).toBe(
      'ws://127.0.0.1:7433/api/pi',
    );
  });
});

describe('protocol transport', () => {
  it('waits for the socket to open and asks for binary frames', async () => {
    const { socket } = await open();

    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('rejects when the socket fails before opening', async () => {
    const connecting = createProtocolTransport('ws://cockpit/api/pi')(handlers());
    FakeSocket.last?.fire('error');

    await expect(connecting).rejects.toThrow(/failed to open/);
  });

  it('delivers binary frames to the client', async () => {
    const { socket, sink } = await open();

    socket.fire('message', { data: new Uint8Array([1, 2, 3]).buffer });

    await vi.waitFor(() => expect(sink.onData).toHaveBeenCalledWith(new Uint8Array([1, 2, 3])));
  });

  it('rejects text frames rather than feeding them to the binary codec', async () => {
    const { socket, sink } = await open();

    socket.fire('message', { data: 'hello' });

    expect(sink.onData).not.toHaveBeenCalled();
    expect(sink.onError).toHaveBeenCalledOnce();
    expect(socket.closed).toBe(true);
  });

  it('reports exactly one terminal callback', async () => {
    const { socket, sink } = await open();

    socket.fire('close');
    socket.fire('error');

    expect(sink.onClose).toHaveBeenCalledOnce();
    expect(sink.onError).not.toHaveBeenCalled();
  });

  it('sends a plain buffer, which is all the socket will take', async () => {
    const { transport, socket } = await open();

    await transport.send(new Uint8Array([9, 8]));

    expect(socket.sent).toHaveLength(1);
    expect(new Uint8Array(socket.sent[0] as ArrayBuffer)).toEqual(new Uint8Array([9, 8]));
  });

  it('closes without sending when an active channel cannot seal', async () => {
    vi.spyOn(sealedProtocolSession, 'sealBinary').mockRejectedValueOnce(new Error('channel exhausted'));
    const { transport, socket, sink } = await open();

    await expect(transport.send(new Uint8Array([9, 8]))).rejects.toThrow('channel exhausted');

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(sink.onError).toHaveBeenCalledOnce();
  });
  it('closes the socket when the client lets go', async () => {
    const { transport, socket } = await open();

    transport.close();

    expect(socket.closed).toBe(true);
  });
  it('rejects a connection closed before it opens', async () => {
    const connecting = createProtocolTransport('ws://cockpit/api/pi')(handlers());
    FakeSocket.last?.fire('close');
    await expect(connecting).rejects.toThrow(/failed to open/);
  });

  it('serializes sealing and never sends a queued frame after closure', async () => {
    let release!: (value: Uint8Array) => void;
    const sealing = vi.spyOn(sealedProtocolSession, 'sealBinary').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { transport, socket, sink } = await open();
    const first = transport.send(new Uint8Array([1]));
    const second = transport.send(new Uint8Array([2]));
    const rejected = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(sealing).toHaveBeenCalledTimes(1));
    transport.close();
    release(new Uint8Array([1]));
    expect((await rejected).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(socket.sent).toEqual([]);
    expect(sink.onClose).toHaveBeenCalledOnce();
    expect(sink.onError).not.toHaveBeenCalled();
  });

  it('does not decrypt a later frame ahead of a pending frame or deliver after close', async () => {
    let release!: (value: Uint8Array) => void;
    const decrypt = vi.spyOn(sealedProtocolSession, 'openBinary').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { socket, sink } = await open();
    socket.fire('message', { data: new Uint8Array([1]).buffer });
    socket.fire('message', { data: new Uint8Array([2]).buffer });
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalledTimes(1));
    socket.fire('close');
    release(new Uint8Array([1]));
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.onData).not.toHaveBeenCalled();
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('terminates once when authentication fails', async () => {
    vi.spyOn(sealedProtocolSession, 'openBinary').mockResolvedValueOnce(undefined);
    const { socket, sink } = await open();
    socket.fire('message', { data: new Uint8Array([1]).buffer });
    await vi.waitFor(() => expect(sink.onError).toHaveBeenCalledOnce());
    socket.fire('close');
    expect(sink.onClose).not.toHaveBeenCalled();
  });

  it('rejects a slow socket before unbounded buffering', async () => {
    const { transport, socket, sink } = await open();
    socket.bufferedAmount = 64 * 1024 * 1024;
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/queue exhausted/);
    expect(socket.sent).toEqual([]);
    expect(sink.onError).toHaveBeenCalledOnce();
  });
});
