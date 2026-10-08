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

it('notifies once per hub notification frame, whether or not the session is focused', () => {
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
    // A transcript reload right after message_end replays the settle entry. The hub
    // frame owns the alert, so that replay can no longer swallow it.
    runtime.presentation?.('session-a', entry('a-live', 'A live'), true);
    runtime.handlers?.onFrame({ type: 'session_frame', sessionId: 'session-a', frame: entry('a-live', 'A live') });
    setActiveSession('session-b');
    runtime.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 'session-a',
      frame: entry('a-background', 'A background'),
    });
    runtime.handlers?.onFrame({
      type: 'session_backlog',
      sessionId: 'session-b',
      frames: [entry('b-history', 'B history')],
    });
    runtime.presentation?.('session-b', entry('b-history', 'B history'), true);

    expect(FakeNotification.seen).toEqual([
      { title: 'A: Finished', options: { body: 'A live', tag: 'doompi:session-a:a-live' } },
      { title: 'A: Finished', options: { body: 'A background', tag: 'doompi:session-a:a-background' } },
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

it('skips alerts for the session the user is looking at', () => {
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
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
    runtime.handlers?.onFrame({ type: 'session_frame', sessionId: 'session-a', frame: entry('a-seen', 'A seen') });
    runtime.handlers?.onFrame({ type: 'session_frame', sessionId: 'session-b', frame: entry('b-away', 'B away') });
    expect(FakeNotification.seen).toEqual([
      { title: 'B: Finished', options: { body: 'B away', tag: 'doompi:session-b:b-away' } },
    ]);
  } finally {
    stop();
  }
});

it('alerts when a running agent opens a dialog, showing its question', () => {
  vi.stubGlobal('Notification', FakeNotification);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
  const stop = startSessionRuntime();
  try {
    runtime.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [
        { id: 'session-a', name: 'A', createdAt: '1', phase: 'turn' },
        { id: 'session-b', name: 'B', createdAt: '2', phase: 'idle' },
      ],
    });
    const dialog = (id: string, extra: Record<string, unknown>) => ({
      type: 'extension_ui_request',
      id,
      method: 'select',
      ...extra,
    });
    runtime.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 'session-a',
      frame: dialog('q1', { title: 'Approve the plan?', message: 'details' }),
    });
    runtime.handlers?.onFrame({ type: 'session_frame', sessionId: 'session-a', frame: dialog('q2', {}) });
    // An idle session's dialog came from a command the user just ran.
    runtime.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 'session-b',
      frame: dialog('q3', { title: 'Pick' }),
    });
    expect(FakeNotification.seen).toEqual([
      { title: 'A: Input needed', options: { body: 'Approve the plan?', tag: 'doompi:session-a:input%3Aq1' } },
      {
        title: 'A: Input needed',
        options: { body: 'The agent is waiting for your answer.', tag: 'doompi:session-a:input%3Aq2' },
      },
    ]);
    expect(sessionStoreFor('session-a').state.entries).toEqual([]);
  } finally {
    stop();
  }
});
