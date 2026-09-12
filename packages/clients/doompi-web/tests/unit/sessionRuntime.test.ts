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
  presentation: undefined as ((sessionId: string, frame: Record<string, unknown>, replay: boolean) => void) | undefined,
}));

const pluginState = vi.hoisted(() => ({
  dispatched: [] as Record<string, unknown>[],
  focus: (_sessionId: string): Promise<void> => Promise.resolve(),
  focusedSessions: [] as string[],
}));

const menuState = vi.hoisted(() => ({ claimed: [] as string[], cleared: 0 }));

vi.mock('../../src/web/lib/pluginRegistry', () => ({
  dispatchChannelFrame: (frame: Record<string, unknown>) => pluginState.dispatched.push(frame),
}));

vi.mock('../../src/web/lib/pluginRuntime', () => ({
  focusSessionWebPlugins: (sessionId: string) => {
    pluginState.focusedSessions.push(sessionId);
    return pluginState.focus(sessionId);
  },
  removeSessionWebPluginRuntime: () => undefined,
}));

vi.mock('../../src/web/app/protocolRuntime', () => ({
  startProtocolRuntime: (_location: unknown, presentation: NonNullable<typeof socketState.presentation>) => {
    socketState.presentation = presentation;
    return { client: {}, focus: () => undefined, stop: () => undefined };
  },
}));

// ProtocolRuntime is stubbed above, so record its command boundary separately.
vi.mock('../../src/web/lib/sessionProtocolCommands', () => ({
  sendSessionProtocolFrame: (sessionId: string, frame: Record<string, unknown>) => {
    socketState.sent.push({ type: 'session_command', sessionId, frame });
  },
}));

vi.mock('../../src/web/lib/protocolHubSocket', () => ({
  createProtocolHubSocket: (_client: unknown, handlers: SocketHandlers) => {
    socketState.handlers = handlers;
    return {
      send: (frame: Record<string, unknown>) => socketState.sent.push(frame),
      close: () => undefined,
    };
  },
}));

vi.mock('../../src/web/lib/browserTelemetry', () => ({
  browserReadyDuration: () => 0,
  recordBrowserPerformance: () => undefined,
}));

vi.mock('../../src/web/stores/menuStore', () => ({
  claimDialogMenu: (id: string) => menuState.claimed.push(id),
  clearPendingMenu: () => {
    menuState.cleared += 1;
  },
}));

import { startSessionRuntime } from '../../src/web/app/sessionRuntime';
import { onHubConnected } from '../../src/web/lib/transport';
import { resetSessions, sessionsStore, setActiveSession } from '../../src/web/stores/sessionsStore';
import { onCaptureStatus, pendingCaptureSessions, submitCapture } from '../../src/web/stores/captureStore';
import {
  applyProtocolTranscript,
  applySessionFrame,
  dropSessionStore,
  requestOlderHistory,
  sessionStoreFor,
} from '../../src/web/stores/sessionStore';
import { threadStoreKey } from '../../src/web/stores/threadStore';

afterEach(() => {
  socketState.handlers = undefined;
  socketState.presentation = undefined;
  vi.useRealTimers();
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
    if (kind !== 'thread') setActiveSession(sessionId);
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

      const live = { type: 'extension_ui_request', method: 'setStatus', statusKey: 'progress', statusText: 'live' };
      if (kind === 'thread') {
        socketState.handlers?.onFrame({ type: 'thread_frame', sessionId, threadId: 'child', frame: live });
      } else {
        socketState.presentation?.(sessionId, live, false);
      }
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
    socketState.presentation?.('s2', { type: 'extension_ui_request', method: 'select', id: 'visible-menu' }, false);
    socketState.presentation?.('s2', { type: 'agent_settled' }, false);

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

  it.each(['close', 'stop'] as const)('clears replay guards when the socket %s', (cleanup) => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const sessionId = `replay-cleanup-${cleanup}`;
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [{ id: sessionId, name: sessionId, createdAt: '1' }],
    });
    setActiveSession(sessionId);

    if (cleanup === 'close') socketState.handlers?.onClose();
    else stop();

    applySessionFrame(sessionId, {
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'live',
      statusText: 'live',
    });
    socketState.handlers?.onFrame({
      type: 'session_backlog',
      sessionId,
      frames: [{ type: 'extension_ui_request', method: 'setStatus', statusKey: 'live', statusText: 'stale' }],
      dropped: 0,
    });

    expect(sessionStoreFor(sessionId).state.statuses).toEqual({ live: 'stale' });
    if (cleanup === 'close') stop();
    dropSessionStore(sessionId);
  });

  it('re-reads the command list when a reload rebuilt the resource catalog', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [{ id: 's1', name: 'Focused', createdAt: '1' }],
    });
    setActiveSession('s1');
    socketState.sent = [];

    // Pi reports a reload no other way, so this journalled entry is the only
    // notice that `$` is completing from the previous selection's skills.
    socketState.presentation?.(
      's1',
      {
        type: 'entry_appended',
        entry: { type: 'custom', customType: 'doom-resource-catalog', data: { version: 1, revision: 7 } },
      },
      false,
    );
    stop();

    expect(sentCommandTypes('s1')).toContain('get_commands');
  });

  it('leaves the command list alone for an unrelated custom entry', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
    const stop = startSessionRuntime();
    socketState.handlers?.onFrame({
      type: 'sessions_snapshot',
      sessions: [{ id: 's1', name: 'Focused', createdAt: '1' }],
    });
    setActiveSession('s1');
    socketState.sent = [];

    socketState.presentation?.(
      's1',
      {
        type: 'entry_appended',
        entry: { type: 'custom', customType: 'doom-minor-modes', data: { version: 1, revision: 1, modes: [] } },
      },
      false,
    );
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

describe('pending capture subscription lifetime', () => {
  it.each(['completed', 'rejected', 'timeout', 'removed', 'close'] as const)(
    'retains a background capture until %s, without claiming replay as execution',
    async (outcome) => {
      vi.useFakeTimers();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: {} } });
      const stop = startSessionRuntime();
      const events: string[] = [];
      const stopStatus = onCaptureStatus(({ status }) => events.push(status));
      try {
        socketState.handlers?.onFrame({
          type: 'sessions_snapshot',
          sessions: [
            { id: 'capture-owner', name: 'Capture', createdAt: '1', attach: 'attached' },
            { id: 'visible', name: 'Visible', createdAt: '2', attach: 'attached' },
          ],
        });
        setActiveSession('capture-owner');
        const bytes = new Uint8Array(33);
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        new DataView(bytes.buffer).setUint32(16, 1);
        new DataView(bytes.buffer).setUint32(20, 1);
        const delivery = submitCapture('capture-owner', {
          data: Buffer.from(bytes).toString('base64'),
          mimeType: 'image/png',
          context: { id: 'capture1', kind: 'capture', source: 'test', label: 'Capture', content: 'Fix this' },
        });
        const result = delivery.then(
          () => 'accepted',
          (error: unknown) => String(error),
        );
        const sent = socketState.sent.find((frame) => frame.type === 'session_command');
        const command = sent?.frame as { id: string; message: string };
        expect(command).toMatchObject({ id: expect.stringContaining('capture-') });
        socketState.sent = [];
        setActiveSession('visible');
        expect(sessionSubscriptionFrames()).toEqual([{ type: 'subscribe', sessionId: 'visible' }]);
        expect(pendingCaptureSessions.state.has('capture-owner')).toBe(true);
        const consume = { type: 'message_start', message: { role: 'user', content: command.message } };
        socketState.handlers?.onFrame({
          type: 'session_backlog',
          sessionId: 'capture-owner',
          frames: [consume, { type: 'agent_settled' }],
        });
        expect(events).toEqual([]);
        const live = (frame: Record<string, unknown>) =>
          socketState.handlers?.onFrame({
            type: 'session_frame',
            sessionId: 'capture-owner',
            frame,
          });
        if (outcome === 'completed') {
          live({ type: 'response', id: command.id, success: true });
          expect(await result).toBe('accepted');
          expect(sessionSubscriptionFrames()).toEqual([{ type: 'subscribe', sessionId: 'visible' }]);
          live(consume);
          live({ type: 'agent_settled' });
          expect(events).toEqual(['queued', 'working', 'completed']);
        } else if (outcome === 'rejected') {
          live({ type: 'response', id: command.id, success: false, error: 'refused' });
          expect(await result).toContain('refused');
        } else if (outcome === 'timeout') {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await result).toContain('not confirmed');
        } else {
          if (outcome === 'removed')
            socketState.handlers?.onFrame({ type: 'session_removed', sessionId: 'capture-owner' });
          else socketState.handlers?.onClose();
          expect(await result).toContain('lost its connection');
        }
        expect(pendingCaptureSessions.state.size).toBe(0);
        expect(sessionSubscriptionFrames()).toContainEqual({ type: 'unsubscribe', sessionId: 'capture-owner' });
      } finally {
        stopStatus();
        stop();
        dropSessionStore('capture-owner');
        dropSessionStore('visible');
      }
    },
  );
});
