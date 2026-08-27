import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSocket, sessionSocketUrl } from '../../src/web/lib/wsClient.ts';
import { sealedSession } from '../../src/web/lib/sealedSession.ts';

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(): void {}

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.emit('close', {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  openIt(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }
}

const install = (): void => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sessionSocketUrl', () => {
  it('follows the page scheme so https pages do not open an insecure socket', () => {
    expect(sessionSocketUrl({ protocol: 'http:', host: '127.0.0.1:7433' })).toBe('ws://127.0.0.1:7433/api/session');
    expect(sessionSocketUrl({ protocol: 'https:', host: 'example.test' })).toBe('wss://example.test/api/session');
  });
});

/** Lets the transport's promise chain drain; it is a pass-through with no channel. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

describe('createSessionSocket', () => {
  it('reports frames and swallows anything that is not an object', async () => {
    install();
    const frames: Array<Record<string, unknown>> = [];
    createSessionSocket('ws://x/api/session', { onFrame: (f) => frames.push(f), onOpen: () => {}, onClose: () => {} });

    const socket = FakeWebSocket.instances[0];
    socket.openIt();
    socket.emit('message', { data: '{"type":"agent_start"}' });
    socket.emit('message', { data: '[1,2]' });
    socket.emit('message', { data: 'not json' });
    socket.emit('message', { data: 42 });

    // Every frame now goes through the sealed transport, which is a
    // pass-through with no channel but still resolves on a microtask.
    await settled();
    expect(frames).toEqual([{ type: 'agent_start' }]);
  });

  it('only writes once the socket is open', async () => {
    install();
    const client = createSessionSocket('ws://x/api/session', {
      onFrame: () => {},
      onOpen: () => {},
      onClose: () => {},
    });

    const socket = FakeWebSocket.instances[0];
    client.send({ type: 'prompt' });
    await settled();
    expect(socket.sent).toHaveLength(0);

    socket.openIt();
    client.send({ type: 'prompt' });
    await settled();
    expect(socket.sent).toEqual(['{"type":"prompt"}']);
  });

  it('closes without sending when an active channel cannot seal', async () => {
    install();
    vi.spyOn(sealedSession, 'sealText').mockRejectedValueOnce(new Error('channel exhausted'));
    const client = createSessionSocket('ws://x/api/session', {
      onFrame: () => {},
      onOpen: () => {},
      onClose: () => {},
    });
    const socket = FakeWebSocket.instances[0];
    socket.openIt();

    client.send({ type: 'private prompt' });
    await settled();

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
  });
  it('reopens after an unexpected close', () => {
    vi.useFakeTimers();
    install();
    const closes: number[] = [];
    createSessionSocket('ws://x/api/session', {
      onFrame: () => {},
      onOpen: () => {},
      onClose: () => closes.push(1),
    });

    FakeWebSocket.instances[0].openIt();
    FakeWebSocket.instances[0].close();
    expect(closes).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops reopening once the page closes it', () => {
    vi.useFakeTimers();
    install();
    const client = createSessionSocket('ws://x/api/session', {
      onFrame: () => {},
      onOpen: () => {},
      onClose: () => {},
    });

    FakeWebSocket.instances[0].openIt();
    client.close();
    vi.advanceTimersByTime(5000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the socket on error so the reopen path runs', () => {
    install();
    createSessionSocket('ws://x/api/session', { onFrame: () => {}, onOpen: () => {}, onClose: () => {} });

    const socket = FakeWebSocket.instances[0];
    socket.emit('error', {});
    expect(socket.closed).toBe(true);
  });
});
