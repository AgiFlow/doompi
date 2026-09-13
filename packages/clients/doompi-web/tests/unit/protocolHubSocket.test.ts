import type { Client } from '@earendil-works/pi-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProtocolHubSocket } from '../../src/web/lib/protocolHubSocket';

const fake = vi.hoisted(() => ({
  binding: vi.fn(),
  transport: vi.fn(() => ({})),
  connectionChanged: (_change: { state: string }): void => {},
}));

vi.mock('@earendil-works/chord', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/chord')>()),
  createRemoteServiceBinding: fake.binding,
}));
vi.mock('@earendil-works/pi-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-client')>()),
  createClientServiceTransport: fake.transport,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function client(): Client {
  return {
    connected: true,
    onConnectionStateChange(listener: typeof fake.connectionChanged) {
      fake.connectionChanged = listener;
      return () => undefined;
    },
  } as unknown as Client;
}

function binding(ready: () => Promise<void> = async () => {}): {
  service: {
    state: { value: { events: never[] }; subscribe: () => () => void };
    send: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };
  value: { use: () => unknown; ready: () => Promise<void>; dispose: ReturnType<typeof vi.fn> };
} {
  const service = {
    state: { value: { events: [] as never[] }, subscribe: () => () => undefined },
    send: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ accepted: true }),
  };
  return {
    service,
    value: {
      use: () => service,
      ready,
      dispose: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('protocol hub socket lifecycle', () => {
  it('only invokes plugin methods on the ready current binding', async () => {
    const first = binding();
    const second = binding();
    fake.binding.mockReturnValueOnce(first.value).mockReturnValueOnce(second.value);
    const socket = createProtocolHubSocket(client(), { onFrame: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() });
    const call = {
      mount: { scope: 'session' as const, sessionId: 'session-a' },
      service: 'documents',
      method: 'open',
      input: { path: 'README.md' },
    };
    await expect(socket.invokePlugin(call)).rejects.toThrow('not connected');
    await Promise.resolve();
    await expect(socket.invokePlugin(call)).resolves.toEqual({ accepted: true });
    expect(first.service.invoke).toHaveBeenCalledWith(call, expect.anything());
    fake.connectionChanged({ state: 'connected' });
    await expect(socket.invokePlugin(call)).rejects.toThrow('not connected');
    await Promise.resolve();
    await socket.invokePlugin(call);
    expect(second.service.invoke).toHaveBeenCalledWith(call, expect.anything());
    expect(first.service.invoke).toHaveBeenCalledOnce();
    socket.close();
    await expect(socket.invokePlugin(call)).rejects.toThrow('not connected');
    expect(second.service.invoke).toHaveBeenCalledOnce();
  });

  it('disposes a stale binding once when a shared client reconnects', async () => {
    let finishFirst!: () => void;
    const first = binding(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = binding();
    fake.binding.mockReturnValueOnce(first.value).mockReturnValueOnce(second.value);
    const handlers = { onFrame: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() };
    const socket = createProtocolHubSocket(client(), handlers);
    await Promise.resolve();

    fake.connectionChanged({ state: 'connected' });
    expect(first.value.dispose).toHaveBeenCalledTimes(1);
    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);

    socket.close();
    expect(second.value.dispose).toHaveBeenCalledTimes(1);
  });
});
