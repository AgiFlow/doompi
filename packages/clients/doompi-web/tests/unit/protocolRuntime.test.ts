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
  applyFrame: vi.fn(),
  applyQueue: vi.fn(),
  reset: vi.fn(),
  refresh: vi.fn(),
  order: [] as string[],
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
vi.mock('../../src/web/lib/sessionProtocolCommands.ts', () => ({ bindSessionProtocol: () => fake.release }));
vi.mock('../../src/web/lib/browserTelemetry.ts', () => ({ recordBrowserPerformance: () => {} }));
vi.mock('../../src/web/stores/sessionStore.ts', () => ({
  applyProtocolTranscript: (...args: unknown[]) => {
    fake.order.push('transcript');
    fake.publish(...args);
  },
  applyProtocolQueue: (...args: unknown[]) => {
    fake.order.push('queue');
    fake.applyQueue(...args);
  },
  applySessionFrame: (...args: unknown[]) => {
    fake.order.push('frame');
    fake.applyFrame(...args);
  },
  beginSessionReplay: () => fake.order.push('begin'),
  endSessionReplay: () => fake.order.push('end'),
  resetSessionStore: () => {
    fake.order.push('reset');
    fake.reset();
  },
  releaseProtocolTranscript: fake.release,
  refreshSessionFacts: fake.refresh,
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
    presentation: { revision: 0, dropped: 0, events: [], projections: [] },
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
  fake.order = [];
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
    fake.publish.mockClear();
    runtime!.stop();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.publish).not.toHaveBeenCalled();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });
  it('resets before applying a branch snapshot and replays when resetRevision advances', async () => {
    await start();
    fake.order = [];
    state.state.snapshot.transcript = [
      { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'new branch' }], timestamp: 1 },
    ];
    state.state.snapshot.queuedSteer = [
      { id: 'queued-1', role: 'user', content: [{ type: 'text', text: 'later' }], timestamp: 2 },
    ];
    state.state.presentation = {
      revision: 1,
      resetRevision: 1,
      dropped: 0,
      projections: [],
      events: [{ sequence: 1, frame: { type: 'agent_start' } }],
    };
    state.publish(BACKGROUND_CONTEXT);
    expect(fake.order).toEqual(['begin', 'reset', 'transcript', 'queue', 'frame', 'end']);
  });
  it('delivers changed presentation projections without requiring a replay', async () => {
    await start();
    state.state.presentation = {
      revision: 1,
      dropped: 0,
      projections: [],
      events: [{ sequence: 1, frame: { type: 'agent_start' } }],
    };
    state.publish(BACKGROUND_CONTEXT);
    fake.order = [];
    fake.applyFrame.mockClear();
    const frame = {
      type: 'extension_ui_request' as const,
      method: 'setStatus' as const,
      statusKey: 'doom-profile',
      statusText: 'reviewer',
    };
    state.state.presentation = {
      revision: 2,
      dropped: 0,
      projections: [{ sequence: 2, frame }],
      events: [{ sequence: 1, frame: { type: 'agent_start' } }],
    };
    state.publish(BACKGROUND_CONTEXT);
    expect(fake.order).toEqual(['transcript', 'queue', 'frame']);
    expect(fake.applyFrame).toHaveBeenCalledExactlyOnceWith('session-1', frame, { replay: false });
  });

  it('replays when the presentation revision regresses even without a ring gap', async () => {
    await start();
    state.state.presentation = {
      revision: 2,
      dropped: 0,
      projections: [],
      events: [{ sequence: 2, frame: { type: 'agent_start' } }],
    };
    state.publish(BACKGROUND_CONTEXT);
    fake.order = [];
    state.state.presentation = { revision: 1, dropped: 0, projections: [], events: [] };
    state.publish(BACKGROUND_CONTEXT);
    expect(fake.order[0]).toBe('begin');
    expect(fake.order[1]).toBe('reset');
  });
});
