import { afterEach, describe, expect, it, vi } from 'vitest';

interface SocketHandlers {
  onFrame(frame: Record<string, unknown>): void;
  onOpen(): void;
  onClose(): void;
}

const socketState = vi.hoisted(() => ({ handlers: undefined as SocketHandlers | undefined }));

vi.mock('../../src/web/lib/wsClient.ts', () => ({
  sessionSocketUrl: () => 'ws://test/api/session',
  createSessionSocket: (_url: string, handlers: SocketHandlers) => {
    socketState.handlers = handlers;
    return { send: () => undefined, close: () => undefined };
  },
}));

vi.mock('../../src/web/app/protocolRuntime.ts', () => ({
  startProtocolRuntime: () => ({ focus: () => undefined, stop: () => undefined }),
}));

vi.mock('../../src/web/lib/browserTelemetry.ts', () => ({
  browserReadyDuration: () => 0,
  recordBrowserPerformance: () => undefined,
}));

import { startSessionRuntime } from '../../src/web/app/sessionRuntime.ts';
import { onHubConnected } from '../../src/web/lib/transport.ts';
import { resetSessions, sessionsStore } from '../../src/web/stores/sessionsStore.ts';

afterEach(() => {
  socketState.handlers = undefined;
  resetSessions();
});

describe('session runtime hub connection lifecycle', () => {
  it('notifies subscribers after every fresh socket snapshot', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const hydratedStates: boolean[] = [];
    const unsubscribe = onHubConnected(() => hydratedStates.push(sessionsStore.state.hydrated));
    const stop = startSessionRuntime();

    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions: [] });
    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions: [] });
    unsubscribe();
    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions: [] });
    stop();

    expect(hydratedStates).toEqual([true, true]);
  });
});
