import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtocolTransport, protocolSocketUrl } from '../../src/web/lib/piTransport.ts';
import { sealedProtocolSession } from '../../src/web/lib/sealedSession.ts';

type Listener = (event: unknown) => void;

/** A WebSocket the test drives, standing in for the browser's. */
class FakeSocket {
  static last: FakeSocket | undefined;
  binaryType = '';
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

  it('drops a text frame rather than handing on bytes the codec never produced', async () => {
    const { socket, sink } = await open();

    socket.fire('message', { data: 'hello' });

    expect(sink.onData).not.toHaveBeenCalled();
  });

  it('reports closure and failure once each', async () => {
    const { socket, sink } = await open();

    socket.fire('close');
    socket.fire('error');

    expect(sink.onClose).toHaveBeenCalledOnce();
    expect(sink.onError).toHaveBeenCalledOnce();
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
});
