import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiHubService } from '../../src/adapters/piHubService.ts';
import type { SessionRecord } from '../../src/types/registry.ts';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  request: vi.fn(),
  disposeClient: vi.fn(),
  disposeBinding: vi.fn(),
  ready: vi.fn(),
  unsubscribe: vi.fn(),
  stopWatch: vi.fn(),
  state: { value: undefined as unknown, subscribe: vi.fn() },
  clientOptions: undefined as any,
  bindingOptions: undefined as any,
  watch: undefined as any,
}));

vi.mock('@earendil-works/pi-client', () => ({
  Client: class {
    constructor(options: unknown) {
      mocks.clientOptions = options;
    }
    connect = mocks.connect;
    request = mocks.request;
    dispose = mocks.disposeClient;
    onConnectionStateChange(callback: unknown) {
      mocks.watch = callback;
      return mocks.stopWatch;
    }
  },
  createClientServiceTransport: vi.fn(() => ({})),
}));
vi.mock('@earendil-works/pi-client/unix', () => ({ createUnixTransportFactory: vi.fn(() => ({})) }));
vi.mock('@earendil-works/chord', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/chord')>()),
  createRemoteServiceBinding: vi.fn((options) => {
    mocks.bindingOptions = options;
    return { use: () => ({ state: mocks.state }), ready: mocks.ready, dispose: mocks.disposeBinding };
  }),
}));

const record: SessionRecord = {
  version: 1,
  id: 'session-1',
  name: 'probe',
  cwd: '/workspace/repo',
  socketPath: '/run/s.sock',
  tokenFile: '/run/token',
  protocolSocketPath: '/run/s.sock.pi',
  protocolServerId: '00000000-0000-4000-8000-000000000001',
  pid: 1234,
  createdAt: '2026-08-26T00:00:00.000Z',
};

function subject(onNotice?: (message: string) => void) {
  return createPiHubService({ records: () => [record], spawn: vi.fn(), onNotice });
}
async function open(onNotice?: (message: string) => void) {
  const host = subject(onNotice);
  return host.openSession(await host.resolveSession(record.id, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.value = { snapshot: {}, progress: {} };
  mocks.state.subscribe.mockReturnValue(mocks.unsubscribe);
});

describe('hub session resource lifecycle', () => {
  it('disposes the client when connecting fails before a binding exists', async () => {
    const error = new Error('connection refused');
    mocks.connect.mockRejectedValue(error);
    await expect(open()).rejects.toBe(error);
    expect(mocks.disposeClient).toHaveBeenCalledOnce();
    expect(mocks.disposeBinding).not.toHaveBeenCalled();
  });

  it('rejects missing initial state and disposes both resources', async () => {
    mocks.state.value = undefined;
    await expect(open()).rejects.toThrow('did not publish initial state');
    expect(mocks.disposeBinding).toHaveBeenCalledWith(BACKGROUND_CONTEXT);
    expect(mocks.disposeClient).toHaveBeenCalledOnce();
  });

  it.each([true, false])('preserves startup failure if binding cleanup fails (notice: %s)', async (notices) => {
    const error = new Error('subscription failed');
    const onNotice = vi.fn();
    mocks.ready.mockRejectedValue(error);
    mocks.disposeBinding.mockRejectedValue(new Error('cleanup failed'));
    await expect(open(notices ? onNotice : undefined)).rejects.toBe(error);
    expect(mocks.disposeClient).toHaveBeenCalledOnce();
    if (notices)
      expect(onNotice).toHaveBeenCalledWith('session session-1 binding cleanup failed: Error: cleanup failed');
  });

  it.each([true, false])('closes once despite binding disposal failure (notice: %s)', async (notices) => {
    const onNotice = vi.fn();
    const handle = await open(notices ? onNotice : undefined);
    mocks.disposeBinding.mockRejectedValue(new Error('cleanup failed'));
    await handle.close(BACKGROUND_CONTEXT);
    await handle.close(BACKGROUND_CONTEXT);
    await expect(handle.terminated).resolves.toBeUndefined();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.stopWatch).toHaveBeenCalledOnce();
    expect(mocks.disposeClient).toHaveBeenCalledOnce();
    if (notices)
      expect(onNotice).toHaveBeenCalledWith('session session-1 binding cleanup failed: Error: cleanup failed');
  });

  it.each([undefined, new Error('transport lost')])(
    'terminates on disconnect with a useful error: %s',
    async (error) => {
      const handle = await open();
      mocks.watch({ state: 'connected' });
      expect(mocks.disposeClient).not.toHaveBeenCalled();
      mocks.watch({ state: 'disconnected', error });
      const termination = await handle.terminated;
      if (error) expect(termination).toBe(error);
      else expect(termination?.message).toBe('Session session-1 protocol disconnected');
      await vi.waitFor(() => expect(mocks.disposeClient).toHaveBeenCalledOnce());
      mocks.watch({ state: 'disconnected' });
      expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])('handles client cleanup rejection after disconnect (notice: %s)', async (notices) => {
    const onNotice = vi.fn();
    const handle = await open(notices ? onNotice : undefined);
    mocks.disposeClient.mockRejectedValue(new Error('client cleanup failed'));
    mocks.watch({ state: 'disconnected' });
    await handle.terminated;
    await vi.waitFor(() => expect(mocks.disposeClient).toHaveBeenCalledOnce());
    if (notices)
      await vi.waitFor(() =>
        expect(onNotice).toHaveBeenCalledWith(
          'session session-1 connection cleanup failed: Error: client cleanup failed',
        ),
      );
  });

  it.each([true, false])('reports listener and service errors when configured (notice: %s)', async (notices) => {
    const onNotice = vi.fn();
    const handle = await open(notices ? onNotice : undefined);
    mocks.clientOptions.onListenerError(new Error('listener failed'));
    mocks.bindingOptions.onError(new Error('service failed'));
    expect(onNotice.mock.calls).toEqual(
      notices
        ? [['session session-1 listener error: listener failed'], ['session session-1 service error: service failed']]
        : [],
    );
    await handle.close(BACKGROUND_CONTEXT);
  });
});
