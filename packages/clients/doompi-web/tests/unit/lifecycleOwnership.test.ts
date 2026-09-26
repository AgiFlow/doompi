import { afterEach, expect, it, vi } from 'vitest';

interface SocketHandlers {
  onFrame(frame: Record<string, unknown>): void;
  onOpen(): void;
  onClose(): void;
}

const runtime = vi.hoisted(() => ({
  handlers: undefined as SocketHandlers | undefined,
  presentation: undefined as ((sessionId: string, frame: Record<string, unknown>, replay: boolean) => void) | undefined,
}));

vi.mock('../../src/web/app/protocolRuntime', () => ({
  startProtocolRuntime: (_location: unknown, presentation: NonNullable<typeof runtime.presentation>) => {
    runtime.presentation = presentation;
    return { client: {}, focus: () => undefined, stop: () => undefined };
  },
}));
vi.mock('../../src/web/lib/protocolHubSocket', () => ({
  createProtocolHubSocket: (_client: unknown, handlers: SocketHandlers) => {
    runtime.handlers = handlers;
    return { send: () => undefined, close: () => undefined };
  },
}));
vi.mock('../../src/web/lib/pluginRuntime', () => ({
  focusSessionWebPlugins: () => Promise.resolve(),
  removeSessionWebPluginRuntime: () => undefined,
}));
vi.mock('../../src/web/lib/pluginRegistry', () => ({
  dispatchChannelFrame: () => undefined,
  sessionToolRenderer: () => undefined,
  sessionWebPluginsInstalled: () => false,
  subscribeWebPluginRegistry: () => () => undefined,
}));
vi.mock('../../src/web/lib/browserTelemetry', () => ({
  browserReadyDuration: () => 0,
  recordBrowserPerformance: () => undefined,
}));

import { startSessionRuntime } from '../../src/web/app/sessionRuntime';
import { resetSessions, setActiveSession } from '../../src/web/stores/sessionsStore';
import { dropSessionStore, sessionStoreFor } from '../../src/web/stores/sessionStore';

const notification = {
  version: 1,
  title: 'Finished',
  subtitle: '',
  body: 'Done',
  level: 'info',
};
const entry = (id: string, body: string) => ({
  type: 'entry_appended',
  entry: { id, type: 'custom', customType: 'doom-notification', data: { ...notification, body } },
});
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static seen: Array<{ title: string; options?: NotificationOptions }> = [];
  constructor(title: string, options?: NotificationOptions) {
    FakeNotification.seen.push({ title, options });
  }
}

afterEach(() => {
  runtime.handlers = undefined;
  runtime.presentation = undefined;
  FakeNotification.seen = [];
  vi.unstubAllGlobals();
  resetSessions();
  dropSessionStore('session-a');
  dropSessionStore('session-b');
});

it('attributes live and replayed notices to their source session across focus changes', () => {
  vi.stubGlobal('Notification', FakeNotification);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
  const stop = startSessionRuntime();
  try {
    runtime.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [
        { id: 'session-a', name: 'A', createdAt: '1' },
        { id: 'session-b', name: 'B', createdAt: '2' },
      ],
    });
    setActiveSession('session-a');
    runtime.presentation?.('session-a', entry('a-live', 'A live'), false);
    setActiveSession('session-b');
    runtime.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 'session-a',
      frame: entry('a-background', 'A background'),
    });
    runtime.presentation?.('session-b', entry('b-live', 'B live'), false);
    runtime.handlers?.onFrame({
      type: 'session_backlog',
      sessionId: 'session-b',
      frames: [entry('b-history', 'B history')],
    });
    runtime.presentation?.('session-b', entry('b-history', 'B history'), true);

    expect(FakeNotification.seen).toEqual([
      { title: 'A: Finished', options: { body: 'A live', tag: 'doompi:session-a:a-live' } },
      { title: 'A: Finished', options: { body: 'A background', tag: 'doompi:session-a:a-background' } },
      { title: 'B: Finished', options: { body: 'B live', tag: 'doompi:session-b:b-live' } },
    ]);
    expect(
      sessionStoreFor('session-a')
        .state.entries.filter((item) => item.kind === 'notice')
        .map((item) => item.text),
    ).toEqual(['A live', 'A background']);
    expect(
      sessionStoreFor('session-b')
        .state.entries.filter((item) => item.kind === 'notice')
        .map((item) => item.text),
    ).toEqual(['B history']);
  } finally {
    stop();
  }
});
