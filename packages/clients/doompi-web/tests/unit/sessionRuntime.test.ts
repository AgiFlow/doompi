import { readFile } from 'node:fs/promises';
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

const pluginState = vi.hoisted(() => ({
  dispatched: [] as Record<string, unknown>[],
  focus: (_sessionId: string): Promise<void> => Promise.resolve(),
  focusedSessions: [] as string[],
}));

const menuState = vi.hoisted(() => ({ claimed: [] as string[], cleared: 0 }));
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

vi.mock('../../src/web/lib/pluginRegistry.ts', () => ({
  dispatchChannelFrame: (frame: Record<string, unknown>) => pluginState.dispatched.push(frame),
}));

vi.mock('../../src/web/lib/pluginRuntime.ts', () => ({
  focusSessionWebPlugins: (sessionId: string) => {
    pluginState.focusedSessions.push(sessionId);
    return pluginState.focus(sessionId);
  },
  removeSessionWebPluginRuntime: () => undefined,
}));

vi.mock('../../src/web/app/protocolRuntime.ts', () => ({
  startProtocolRuntime: () => ({ focus: () => undefined, stop: () => undefined }),
}));

vi.mock('../../src/web/lib/browserTelemetry.ts', () => ({
  browserReadyDuration: () => 0,
  recordBrowserPerformance: () => undefined,
}));

vi.mock('../../src/web/stores/menuStore.ts', () => ({
  claimDialogMenu: (id: string) => menuState.claimed.push(id),
  clearPendingMenu: () => {
    menuState.cleared += 1;
  },
}));

import { startSessionRuntime } from '../../src/web/app/sessionRuntime.ts';
import { onHubConnected } from '../../src/web/lib/transport.ts';
import { resetSessions, sessionsStore, setActiveSession } from '../../src/web/stores/sessionsStore.ts';
import {
  applyProtocolTranscript,
  applySessionFrame,
  dropSessionStore,
  requestOlderHistory,
  sessionStoreFor,
} from '../../src/web/stores/sessionStore.ts';
import { threadStoreKey } from '../../src/web/stores/threadStore.ts';

afterEach(() => {
  socketState.handlers = undefined;
  socketState.sent = [];
  pluginState.dispatched = [];
  pluginState.focus = (_sessionId: string) => Promise.resolve();
  pluginState.focusedSessions = [];
  menuState.claimed = [];
  menuState.cleared = 0;
  resetSessions();
});

/** The command types the page asked one session's agent for. */
function sentCommandTypes(sessionId: string): string[] {
  return socketState.sent
    .filter((frame) => frame.type === 'session_command' && frame.sessionId === sessionId)
    .map((frame) => (frame.frame as { type?: string } | undefined)?.type ?? '')
    .filter((type) => type.length > 0);
}

function sessionSubscriptionFrames(): Record<string, unknown>[] {
  return socketState.sent.filter((frame) => frame.type === 'subscribe' || frame.type === 'unsubscribe');
}
describe('session runtime backlog publication', () => {
  it.each(['session', 'protocol', 'thread'] as const)('publishes only the completed %s replay', (kind) => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const sessionId = `backlog-${kind}`;
    const key = kind === 'thread' ? threadStoreKey(sessionId, 'child') : sessionId;
    const otherId = `${sessionId}-other`;
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [{ id: sessionId, name: kind, createdAt: '1' }],
    });
    applySessionFrame(key, {
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'stale',
      statusText: 'old',
    });
    if (kind === 'protocol') {
      applyProtocolTranscript(
        key,
        [{ kind: 'assistant', id: 'protocol-1', text: 'history', thinking: '', streaming: false }],
        false,
      );
    }
    const store = sessionStoreFor(key);
    const otherState = sessionStoreFor(otherId).state;
    const published = vi.fn();
    const commandsDuringPublish: string[][] = [];
    const subscription = store.subscribe((state) => {
      published(state);
      commandsDuringPublish.push(sentCommandTypes(sessionId));
    });
    socketState.sent = [];
    const frames = [
      {
        type: 'entry_appended',
        entry: {
          type: 'message',
          id: 'oldest-entry',
          message: { role: 'user', content: [{ type: 'text', text: 'replayed' }] },
        },
      },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: 'progress',
        statusText: String(index),
      })),
    ];

    try {
      socketState.handlers?.onFrame({
        type: kind === 'thread' ? 'thread_backlog' : 'session_backlog',
        sessionId,
        threadId: 'child',
        frames,
        dropped: 4,
      });

      expect(published).toHaveBeenCalledTimes(1);
      expect(published).toHaveBeenCalledWith(store.state);
      expect(commandsDuringPublish).toEqual([[]]);
      expect(store.state.statuses).toEqual({ progress: '999' });
      expect(store.state.entries).toEqual([
        expect.objectContaining(
          kind === 'protocol'
            ? { kind: 'assistant', id: 'protocol-1', text: 'history' }
            : { kind: 'user', text: 'replayed' },
        ),
      ]);
      expect(sessionStoreFor(otherId).state).toBe(otherState);
      if (kind === 'thread') {
        expect(sentCommandTypes(sessionId)).toEqual([]);
        expect(sessionStoreFor(sessionId).state.entries).toEqual([]);
      } else {
        expect(sentCommandTypes(sessionId)).toEqual(['get_state', 'get_session_stats', 'get_commands']);
        expect(sessionsStore.state.byId[sessionId]).toMatchObject({ replayed: frames.length, dropped: 4 });
        expect(requestOlderHistory(sessionId)).toBe(true);
        expect(socketState.sent.at(-1)).toEqual({ type: 'history_request', sessionId, before: 'oldest-entry' });
      }

      socketState.handlers?.onFrame({
        type: kind === 'thread' ? 'thread_frame' : 'session_frame',
        sessionId,
        threadId: 'child',
        frame: { type: 'extension_ui_request', method: 'setStatus', statusKey: 'progress', statusText: 'live' },
      });
      expect(published).toHaveBeenCalledTimes(2);
      expect(store.state.statuses.progress).toBe('live');
    } finally {
      subscription.unsubscribe();
      stop();
      dropSessionStore(key);
      dropSessionStore(sessionId);
      dropSessionStore(otherId);
    }
  });
});

describe('session runtime voice subscription lifetime', () => {
  it('keeps the voice owner subscribed while another session is visible', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [
        { id: 's1', name: 'Voice owner', createdAt: '1' },
        { id: 's2', name: 'Visible', createdAt: '2' },
      ],
    });
    setActiveSession('s1');
    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 's1',
      payload: { activeSessionId: 's1' },
    });
    socketState.sent = [];

    setActiveSession('s2');

    expect(sessionSubscriptionFrames()).toEqual([{ type: 'subscribe', sessionId: 's2' }]);
    stop();
  });

  it('releases the previous owner subscription after voice stops', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [
        { id: 's1', name: 'Voice owner', createdAt: '1' },
        { id: 's2', name: 'Visible', createdAt: '2' },
      ],
    });
    setActiveSession('s1');
    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 's1',
      payload: { activeSessionId: 's1' },
    });
    setActiveSession('s2');
    socketState.sent = [];

    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 's1',
      payload: { activeSessionId: null },
    });

    expect(sessionSubscriptionFrames()).toEqual([{ type: 'unsubscribe', sessionId: 's1' }]);
    stop();
  });

  it('keeps background owner frames away from the visible session menu', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [
        { id: 's1', name: 'Voice owner', createdAt: '1' },
        { id: 's2', name: 'Visible', createdAt: '2' },
      ],
    });
    setActiveSession('s1');
    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 's1',
      payload: { activeSessionId: 's1' },
    });
    setActiveSession('s2');

    socketState.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 's1',
      frame: { type: 'extension_ui_request', method: 'select', id: 'background-menu' },
    });
    socketState.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 's1',
      frame: { type: 'agent_settled' },
    });
    socketState.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 's2',
      frame: { type: 'extension_ui_request', method: 'select', id: 'visible-menu' },
    });
    socketState.handlers?.onFrame({
      type: 'session_frame',
      sessionId: 's2',
      frame: { type: 'agent_settled' },
    });

    expect(menuState.claimed).toEqual(['visible-menu']);
    expect(menuState.cleared).toBe(1);
    stop();
  });

  it('restores both visible and owner subscriptions after a fresh socket snapshot', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const sessions = [
      { id: 's1', name: 'Voice owner', createdAt: '1' },
      { id: 's2', name: 'Visible', createdAt: '2' },
    ];
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions });
    setActiveSession('s1');
    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 's1',
      payload: { activeSessionId: 's1' },
    });
    setActiveSession('s2');
    socketState.sent = [];

    socketState.handlers?.onFrame({ type: 'sessions_snapshot', sessions });

    expect(sessionSubscriptionFrames()).toEqual([
      { type: 'subscribe', sessionId: 's2' },
      { type: 'subscribe', sessionId: 's1' },
    ]);
    stop();
  });
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

  it('moves route focus before applying transferred voice ownership and shows the transition', async () => {
    const pushState = vi.fn();
    const dispatchEvent = vi.fn();
    let releaseTargetFocus: (() => void) | undefined;
    let targetFocusStarted = false;
    pluginState.focus = (sessionId) => {
      if (sessionId !== 'target' || targetFocusStarted) return Promise.resolve();
      targetFocusStarted = true;
      return new Promise<void>((resolve) => {
        releaseTargetFocus = resolve;
      });
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: {}, history: { pushState }, dispatchEvent },
    });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [
        { id: 'source', name: 'Source', createdAt: '1' },
        { id: 'target', name: 'Target', createdAt: '2' },
      ],
    });
    setActiveSession('source');
    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 'source',
      payload: { activeSessionId: 'source' },
    });
    socketState.handlers?.onFrame({
      type: 'voice_ownership',
      sessionId: 'source',
      payload: { activeSessionId: 'target' },
    });

    expect(pushState).toHaveBeenCalledWith(null, '', '/session/target');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'popstate' }));
    expect(sessionsStore.state.activeId).toBe('target');
    expect(sessionsStore.state.transferringToId).toBe('target');
    expect(pluginState.focusedSessions).toContain('target');
    expect(pluginState.dispatched.at(-1)).toMatchObject({ payload: { activeSessionId: 'source' } });

    socketState.handlers?.onFrame({
      type: 'session_upsert',
      session: { id: 'target', name: 'Target', createdAt: '2' },
    });
    await Promise.resolve();
    expect(pluginState.dispatched.at(-1)).toMatchObject({ payload: { activeSessionId: 'source' } });
    releaseTargetFocus?.();
    await Promise.resolve();
    expect(pluginState.dispatched.at(-1)).toMatchObject({ payload: { activeSessionId: 'target' } });
    expect(sessionsStore.state.transferringToId).toBeNull();
    stop();

    const cockpitSource = await readFile(new URL('../../src/web/routes/CockpitPage.tsx', import.meta.url), 'utf8');
    expect(cockpitSource).toContain('data-testid="voice-transfer-transition"');
    expect(cockpitSource).toContain('Transferring voice to {transferLabel}...');
  });
});
