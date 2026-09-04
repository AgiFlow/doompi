import { replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SessionServiceState } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  connected: false,
  attachmentChanged: (_attachment: unknown): void => {},
  connectionChanged: (_change: { state: string }): void => {},
  connect: vi.fn<() => Promise<void>>(),
  request: vi.fn<(...args: unknown[]) => Promise<void>>(),
  dispose: vi.fn<() => Promise<void>>(),
  binding: vi.fn(),
  publish: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@earendil-works/pi-client', () => ({
  Client: class {
    get connected() {
      return fake.connected;
    }
    connect = fake.connect;
    request = fake.request;
    dispose = fake.dispose;
    onAttachmentChange(listener: typeof fake.attachmentChanged) {
      fake.attachmentChanged = listener;
    }
    onConnectionStateChange(listener: typeof fake.connectionChanged) {
      fake.connectionChanged = listener;
    }
  },
  createClientServiceTransport: () => ({}),
}));
vi.mock('@earendil-works/chord', async (original) => ({
  ...(await original<typeof import('@earendil-works/chord')>()),
  createRemoteServiceBinding: fake.binding,
}));
vi.mock('../../src/web/lib/piTransport.ts', () => ({
  protocolSocketUrl: () => 'ws://test/api/pi',
  createProtocolTransport: () => ({}),
}));
vi.mock('../../src/web/lib/browserTelemetry.ts', () => ({ recordBrowserPerformance: () => {} }));
vi.mock('../../src/web/stores/sessionStore.ts', () => ({
  applyProtocolTranscript: fake.publish,
  releaseProtocolTranscript: fake.release,
  applyProtocolQueue: () => {},
}));

import { startProtocolRuntime, type ProtocolRuntime } from '../../src/web/app/protocolRuntime.ts';

function sessionState() {
  return replicatedState<SessionServiceState>({
    snapshot: {
      id: 'session-1',
      name: 'test',
      cwd: '/test',
      phase: 'idle',
      createdAt: 1,
      updatedAt: 1,
      model: { provider: 'test', id: 'test' },
      thinkingLevel: 'off',
      attached: true,
      locked: false,
      revision: 0,
      transcript: [],
      queuedSteer: [],
      queuedSteerCount: 0,
    },
    progress: null,
  });
}

let runtime: ProtocolRuntime | undefined;
let state: ReturnType<typeof sessionState>;
let disposeBinding: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fake.connected = false;
  fake.connect.mockImplementation(async () => {
    fake.connected = true;
  });
  fake.request.mockResolvedValue(undefined);
  fake.dispose.mockResolvedValue(undefined);
  state = sessionState();
  disposeBinding = vi.fn().mockResolvedValue(undefined);
  fake.binding.mockImplementation(() => ({
    use: () => ({ state }),
    ready: async () => {},
    dispose: disposeBinding,
  }));
});

afterEach(async () => {
  runtime?.stop();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

async function start() {
  runtime = startProtocolRuntime({} as Location);
  runtime.focus('session-1');
  await vi.advanceTimersByTimeAsync(0);
}

describe('protocol attachment recovery', () => {
  it('retries a restarting session and publishes subsequent updates without reconnecting the hub socket', async () => {
    await start();
    fake.request.mockRejectedValueOnce(new Error('replacement is not registered yet'));
    fake.attachmentChanged(undefined);
    expect(fake.release).toHaveBeenCalledWith('session-1');
    await vi.advanceTimersByTimeAsync(700);
    expect(fake.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(700);
    expect(fake.request).toHaveBeenCalledTimes(3);
    expect(fake.connect).toHaveBeenCalledTimes(1);

    state.state.snapshot.transcript = [
      { id: 'new', role: 'user', content: [{ type: 'text', text: 'live again' }], timestamp: 1 },
    ];
    state.publish(BACKGROUND_CONTEXT);
    expect(fake.publish).toHaveBeenLastCalledWith(
      'session-1',
      [expect.objectContaining({ text: 'live again' })],
      false,
    );
  });

  it('cancels attachment retries when the page stops focusing the session', async () => {
    await start();
    fake.attachmentChanged(undefined);
    runtime!.focus(null);
    await vi.advanceTimersByTimeAsync(1400);
    expect(fake.request).toHaveBeenCalledTimes(1);
  });

  it('recovers a disconnected hub and tolerates disposal of the lost binding', async () => {
    await start();
    disposeBinding.mockRejectedValueOnce(new Error('attachment is gone'));
    fake.connected = false;
    fake.attachmentChanged(undefined);
    fake.connectionChanged({ state: 'disconnected' });
    await vi.advanceTimersByTimeAsync(700);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.request).toHaveBeenCalledTimes(2);
  });

  it('does not publish a binding that finishes opening after shutdown', async () => {
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fake.binding.mockImplementation(() => ({ use: () => ({ state }), ready: () => pending, dispose: disposeBinding }));
    await start();
    runtime!.stop();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.publish).not.toHaveBeenCalled();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });
});
