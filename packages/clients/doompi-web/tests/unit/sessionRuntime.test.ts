import { afterEach, describe, expect, it, vi } from 'vitest';

interface SocketHandlers {
  onFrame(frame: Record<string, unknown>): void;
  onOpen(): void;
  onClose(): void;
}

const socketState = vi.hoisted(() => ({
  handlers: undefined as SocketHandlers | undefined,
  sent: [] as Record<string, unknown>[],
}));

vi.mock('../../src/web/lib/wsClient.ts', () => ({
  sessionSocketUrl: () => 'ws://test/api/session',
  createSessionSocket: (_url: string, handlers: SocketHandlers) => {
    socketState.handlers = handlers;
    return {
      send: (frame: Record<string, unknown>) => socketState.sent.push(frame),
      close: () => undefined,
    };
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
  socketState.sent = [];
  resetSessions();
});

/** The command types the page asked one session's agent for. */
function sentCommandTypes(sessionId: string): string[] {
  return socketState.sent
    .filter((frame) => frame.type === 'session_command' && frame.sessionId === sessionId)
    .map((frame) => (frame.frame as { type?: string } | undefined)?.type ?? '')
    .filter((type) => type.length > 0);
}

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

  it('re-reads the command list when a reload rebuilt the resource catalog', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions: [] });
    socketState.sent = [];

    // Pi reports a reload no other way, so this journalled entry is the only
    // notice that `$` is completing from the previous selection's skills.
    socketState.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 's1',
      frame: {
        type: 'entry_appended',
        entry: { type: 'custom', customType: 'doom-resource-catalog', data: { version: 1, revision: 7 } },
      },
    });
    stop();

    expect(sentCommandTypes('s1')).toContain('get_commands');
  });

  it('leaves the command list alone for an unrelated custom entry', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions: [] });
    socketState.sent = [];

    socketState.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 's1',
      frame: {
        type: 'entry_appended',
        entry: { type: 'custom', customType: 'doom-minor-modes', data: { version: 1, revision: 1, modes: [] } },
      },
    });
    stop();

    expect(sentCommandTypes('s1')).not.toContain('get_commands');
  });
});
