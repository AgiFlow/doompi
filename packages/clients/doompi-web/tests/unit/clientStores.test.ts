import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/types/hub.ts';
import {
  abortCommand,
  dialogCancelled,
  dialogConfirmed,
  dialogValue,
  followUpCommand,
  getAvailableModelsCommand,
  getAvailableThinkingLevelsCommand,
  getCommandsCommand,
  getSessionStatsCommand,
  getStateCommand,
  promptCommand,
  setModelCommand,
  setThinkingLevelCommand,
  steerCommand,
} from '../../src/web/lib/commands.ts';
import { bindTransport, releaseTransport, sendFrame, sendHubFrame } from '../../src/web/lib/transport.ts';
import {
  dropThreads,
  heldThreads,
  resetThreads,
  resubscribeThreads,
  subscribeThread,
  threadStoreKey,
  unsubscribeThread,
} from '../../src/web/stores/threadStore.ts';
import {
  closeTransientTab,
  dropTransientTabs,
  findTransientTab,
  openTransientTab,
  resetTransientTabs,
  transientTabsOf,
  transientTabsStore,
} from '../../src/web/stores/transientTabsStore.ts';
import {
  closePalette,
  openPalette,
  paletteStore,
  setPalettePath,
  togglePalette,
} from '../../src/web/stores/paletteStore.ts';
import {
  abortRun,
  answerDialogConfirm,
  answerDialogValue,
  applyProtocolTranscript,
  applySessionFrame,
  cancelDialog,
  dropSessionStore,
  loadModelChoices,
  queueFollowUp,
  refreshSessionFacts,
  renameSession,
  releaseProtocolTranscript,
  resetSessionStore,
  resetSessionStores,
  runCommand,
  selectModel,
  selectThinkingLevel,
  sessionStoreFor,
  submitMessage,
} from '../../src/web/stores/sessionStore.ts';
import {
  applySessionBacklog,
  applySessionRemoved,
  applySessionsSnapshot,
  applySessionUpsert,
  markSocketClosed,
  noSessions,
  resetSessions,
  sessionsStore,
  setActiveSession,
  waitForSession,
} from '../../src/web/stores/sessionsStore.ts';
import {
  closeNewSession,
  newSessionStore,
  openNewSession,
  resetNewSessionStore,
} from '../../src/web/stores/newSessionStore.ts';

type Frame = Record<string, unknown>;

let sent: Frame[] = [];

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: 'untitled',
    cwd: `/workspace/${id}`,
    createdAt: `2026-08-24T00:00:0${id.length}.000Z`,
    updatedAt: '2026-08-24T00:00:00.000Z',
    phase: 'idle',
    phaseSince: '2026-08-24T00:00:00.000Z',
    attach: 'attached',
    pendingMessageCount: 0,
    everPrompted: false,
    awaitingInput: false,
    socketPath: `/run/${id}.sock`,
    ...overrides,
  };
}

beforeEach(() => {
  sent = [];
  resetSessionStores();
  resetSessions();
  resetNewSessionStore();
  bindTransport((frame) => sent.push(frame as Frame));
});

describe('command builders', () => {
  it('name the frames the RPC protocol expects', () => {
    expect(promptCommand('a')).toEqual({ type: 'prompt', message: 'a' });
    expect(steerCommand('b')).toEqual({ type: 'steer', message: 'b' });
    expect(followUpCommand('c')).toEqual({ type: 'follow_up', message: 'c' });
    const images = [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }];
    expect(promptCommand('look', images)).toEqual({ type: 'prompt', message: 'look', images });
    expect(steerCommand('look', images)).toEqual({ type: 'steer', message: 'look', images });
    expect(followUpCommand('look', images)).toEqual({ type: 'follow_up', message: 'look', images });
    expect(abortCommand()).toEqual({ type: 'abort' });
    expect(getStateCommand()).toEqual({ type: 'get_state' });
    expect(getSessionStatsCommand()).toEqual({ type: 'get_session_stats' });
    expect(getCommandsCommand()).toEqual({ type: 'get_commands' });
    expect(getAvailableModelsCommand()).toEqual({ type: 'get_available_models' });
    expect(getAvailableThinkingLevelsCommand()).toEqual({ type: 'get_available_thinking_levels' });
    expect(setModelCommand('openai', 'gpt-5.6')).toEqual({ type: 'set_model', provider: 'openai', modelId: 'gpt-5.6' });
    expect(setThinkingLevelCommand('high')).toEqual({ type: 'set_thinking_level', level: 'high' });
    expect(dialogValue('1', 'v')).toEqual({ type: 'extension_ui_response', id: '1', value: 'v' });
    expect(dialogConfirmed('2', false)).toEqual({ type: 'extension_ui_response', id: '2', confirmed: false });
    expect(dialogCancelled('3')).toEqual({ type: 'extension_ui_response', id: '3', cancelled: true });
  });
});

describe('transcript ownership', () => {
  const applyLegacyAssistant = (id: string, text: string) => {
    applySessionFrame('s1', { type: 'message_start', message: { id, role: 'assistant', content: [] } });
    applySessionFrame('s1', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
    });
    applySessionFrame('s1', {
      type: 'message_end',
      message: { id, role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
    });
  };

  it('uses legacy frames until the protocol publishes a transcript', () => {
    applyLegacyAssistant('legacy-1', 'live fallback');

    expect(sessionStoreFor('s1').state.entries).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'live fallback' }),
    ]);
  });

  it('keeps an optimistic prompt until the protocol publishes it', () => {
    setActiveSession('s1');
    submitMessage('stay visible');

    applyProtocolTranscript('s1', [], false);
    expect(sessionStoreFor('s1').state.entries).toEqual([
      expect.objectContaining({ kind: 'user', text: 'stay visible' }),
    ]);

    applyProtocolTranscript('s1', [{ kind: 'user', id: 'protocol-user', text: 'stay visible' }], false);
    expect(sessionStoreFor('s1').state.entries).toEqual([{ kind: 'user', id: 'protocol-user', text: 'stay visible' }]);
  });
  it('preserves a protocol transcript through a legacy backlog reset', () => {
    applyProtocolTranscript(
      's1',
      [{ kind: 'assistant', id: 'protocol-1', text: 'restored history', thinking: '', streaming: false }],
      false,
    );

    resetSessionStore('s1');
    applyLegacyAssistant('legacy-ignored', 'duplicate');

    expect(sessionStoreFor('s1').state.entries).toEqual([
      { kind: 'assistant', id: 'protocol-1', text: 'restored history', thinking: '', streaming: false },
    ]);
  });

  it('returns realtime ownership to legacy frames after protocol failure', () => {
    applyProtocolTranscript(
      's1',
      [{ kind: 'assistant', id: 'protocol-1', text: 'history', thinking: '', streaming: false }],
      false,
    );

    releaseProtocolTranscript('s1');
    applyLegacyAssistant('legacy-2', 'live again');

    expect(sessionStoreFor('s1').state.entries).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'history' }),
      expect.objectContaining({ kind: 'assistant', text: 'live again' }),
    ]);
  });
});
describe('transport', () => {
  it('envelopes session commands with the session id', () => {
    sendFrame('s1', promptCommand('hello'));
    expect(sent).toEqual([{ type: 'session_command', sessionId: 's1', frame: { type: 'prompt', message: 'hello' } }]);
  });

  it('sends hub frames unenveloped', () => {
    sendHubFrame({ type: 'subscribe', sessionId: 's1' });
    expect(sent).toEqual([{ type: 'subscribe', sessionId: 's1' }]);
  });

  it('drops frames when nothing is bound rather than throwing', () => {
    releaseTransport();
    expect(() => sendFrame('s1', { type: 'prompt' })).not.toThrow();
    bindTransport((frame) => sent.push(frame as Frame));
  });
});

describe('sessionsStore', () => {
  it('hydrates from a snapshot and sorts the rail by creation', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('late'), summary('x')] });
    expect(sessionsStore.state.hydrated).toBe(true);
    // 'x' is older by the createdAt scheme above (shorter id).
    expect(sessionsStore.state.order).toEqual(['x', 'late']);
  });

  it('upserts one session without touching the others', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a'), summary('b')] });
    applySessionUpsert({ type: 'session_upsert', session: summary('b', { phase: 'turn' }) });
    expect(sessionsStore.state.byId.b.summary.phase).toBe('turn');
    expect(sessionsStore.state.byId.a.summary.phase).toBe('idle');
  });

  it('removes a session that left', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a'), summary('b')] });
    applySessionRemoved({ type: 'session_removed', sessionId: 'a' });
    expect(sessionsStore.state.order).toEqual(['b']);
  });

  it('keeps a refusal sticky per session while the hub retries underneath', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a'), summary('b')] });
    applySessionUpsert({
      type: 'session_upsert',
      session: summary('a', { attach: 'refused', attachReason: 'Another client already holds this session.' }),
    });
    applySessionUpsert({ type: 'session_upsert', session: summary('a', { attach: 'connecting' }) });
    expect(sessionsStore.state.byId.a.attach).toBe('refused');
    expect(sessionsStore.state.byId.a.reason).toMatch(/Another client/);
    // The other session's churn is unaffected.
    expect(sessionsStore.state.byId.b.attach).toBe('attached');

    applySessionUpsert({ type: 'session_upsert', session: summary('a', { attach: 'attached' }) });
    expect(sessionsStore.state.byId.a.attach).toBe('attached');
  });

  it('records what a subscribe replayed', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a')] });
    applySessionBacklog('a', 7, 2);
    expect(sessionsStore.state.byId.a).toMatchObject({ replayed: 7, dropped: 2 });
  });

  it('marks every session offline when the page socket dies', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a'), summary('b')] });
    markSocketClosed();
    expect(sessionsStore.state.byId.a.attach).toBe('offline');
    expect(sessionsStore.state.byId.b.attach).toBe('offline');
    expect(sessionsStore.state.byId.a.reason).toBe('The cockpit lost its bridge.');
  });

  it('ignores a malformed summary', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [{ name: 'no-id' }] });
    expect(sessionsStore.state.order).toEqual([]);
  });

  it('waits for a created session to appear before reporting it', async () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a')] });
    await expect(waitForSession('a')).resolves.toBe(true);

    const pending = waitForSession('fresh');
    applySessionUpsert({ type: 'session_upsert', session: summary('fresh') });
    await expect(pending).resolves.toBe(true);

    await expect(waitForSession('never', 20)).resolves.toBe(false);
  });
});

describe('menuStore', () => {
  it('anchors a fresh selection command and expires a stale one', async () => {
    const { setPendingMenu, clearPendingMenu, pendingMenuFor } = await import('../../src/web/stores/menuStore.ts');
    clearPendingMenu();
    expect(pendingMenuFor(Date.now())).toBeNull();

    setPendingMenu('mode');
    expect(pendingMenuFor(Date.now())).toBe('mode');
    // A dialog arriving long after the click is not this menu.
    expect(pendingMenuFor(Date.now() + 60_000)).toBeNull();

    clearPendingMenu();
    expect(pendingMenuFor(Date.now())).toBeNull();
  });

  it('spends the anchor on the dialog that answers it, and releases the claim', async () => {
    const { claimDialogMenu, menuStore, releaseDialogMenu, resetMenuStore, setPendingMenu } =
      await import('../../src/web/stores/menuStore.ts');
    resetMenuStore();

    setPendingMenu('domains');
    expect(claimDialogMenu('d1')).toEqual({ dialogId: 'd1', menu: 'domains' });
    expect(menuStore.state.claimed).toEqual({ dialogId: 'd1', menu: 'domains' });
    // The anchor is spent: a second dialog is nobody's menu.
    expect(claimDialogMenu('d2')).toBeNull();
    expect(menuStore.state.pending).toBeNull();

    setPendingMenu('mode');
    claimDialogMenu('d3');
    releaseDialogMenu('other');
    expect(menuStore.state.claimed).toEqual({ dialogId: 'd3', menu: 'mode' });
    releaseDialogMenu('d3');
    expect(menuStore.state.claimed).toBeNull();
    resetMenuStore();
  });
});

describe('promptFocus', () => {
  it('hands the keyboard back to the registered input, and never to a disabled one', async () => {
    const { focusPrompt, registerPromptInput } = await import('../../src/web/lib/promptFocus.ts');

    let focused = 0;
    const input = { disabled: false, focus: () => (focused += 1) } as unknown as HTMLTextAreaElement;
    const release = registerPromptInput(input);
    focusPrompt();
    expect(focused).toBe(1);

    // A composer with no session behind it cannot take the caret.
    (input as unknown as { disabled: boolean }).disabled = true;
    focusPrompt();
    expect(focused).toBe(1);

    (input as unknown as { disabled: boolean }).disabled = false;
    release();
    focusPrompt();
    expect(focused).toBe(1);

    // Registering null is how a composer that never mounted stays harmless.
    registerPromptInput(null);
    expect(() => focusPrompt()).not.toThrow();
  });
});

describe('noSessions', () => {
  it('stays false before the hub has answered, whatever the order looks like', () => {
    // An empty order before hydration only means no snapshot has arrived, and
    // reading it as "no sessions" would flash onboarding at someone with ten.
    expect(sessionsStore.state.hydrated).toBe(false);
    expect(noSessions(sessionsStore.state)).toBe(false);
  });

  it('is true once the hub has answered with nothing', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [] });
    expect(noSessions(sessionsStore.state)).toBe(true);
  });

  it('is false while any session exists, and true again once the last one goes', () => {
    applySessionsSnapshot({ type: 'sessions_snapshot', sessions: [summary('a')] });
    expect(noSessions(sessionsStore.state)).toBe(false);

    applySessionRemoved({ type: 'session_removed', sessionId: 'a' });
    expect(noSessions(sessionsStore.state)).toBe(true);
  });
});

describe('newSessionStore', () => {
  it('opens and closes, so every entry point drives one dialog', () => {
    expect(newSessionStore.state.open).toBe(false);
    openNewSession();
    expect(newSessionStore.state.open).toBe(true);

    // Opening an already-open dialog publishes nothing to re-render.
    const held = newSessionStore.state;
    openNewSession();
    expect(newSessionStore.state).toBe(held);

    closeNewSession();
    expect(newSessionStore.state.open).toBe(false);
    const closed = newSessionStore.state;
    closeNewSession();
    expect(newSessionStore.state).toBe(closed);
  });
});

describe('paletteStore', () => {
  it('opens, toggles, and always resets the key path', () => {
    setPalettePath('p');
    openPalette();
    expect(paletteStore.state).toEqual({ open: true, path: '' });

    setPalettePath('p');
    togglePalette();
    expect(paletteStore.state).toEqual({ open: false, path: '' });

    togglePalette();
    expect(paletteStore.state.open).toBe(true);
    closePalette();
    expect(paletteStore.state.open).toBe(false);
  });
});

describe('session store registry', () => {
  it('folds frames into the addressed session only', () => {
    applySessionFrame('a', { type: 'agent_start' });
    expect(sessionStoreFor('a').state.streaming).toBe(true);
    expect(sessionStoreFor('b').state.streaming).toBe(false);
  });

  it('resets one session for a replay without touching the rest', () => {
    applySessionFrame('a', { type: 'agent_start' });
    applySessionFrame('b', { type: 'agent_start' });
    resetSessionStore('a');
    expect(sessionStoreFor('a').state.streaming).toBe(false);
    expect(sessionStoreFor('b').state.streaming).toBe(true);
  });

  it('drops a removed session outright', () => {
    applySessionFrame('a', { type: 'agent_start' });
    dropSessionStore('a');
    expect(sessionStoreFor('a').state.streaming).toBe(false);
  });
});

describe('session actions', () => {
  it('address the focused session by default', () => {
    setActiveSession('s1');
    submitMessage('first');
    expect(sent).toEqual([{ type: 'session_command', sessionId: 's1', frame: { type: 'prompt', message: 'first' } }]);
  });

  it('are a silent no-op while nothing is focused', () => {
    submitMessage('lost');
    abortRun();
    queueFollowUp('also lost');
    renameSession('nobody');
    expect(sent).toHaveLength(0);
  });

  it('rename through the agent and read the state back', () => {
    setActiveSession('s1');
    renameSession('  gate-review ');
    renameSession('   ');
    expect(sent).toEqual([
      { type: 'session_command', sessionId: 's1', frame: { type: 'set_session_name', name: 'gate-review' } },
      { type: 'session_command', sessionId: 's1', frame: { type: 'get_state' } },
    ]);
  });

  it('prompt when idle and steer when the addressed agent is running', () => {
    setActiveSession('s1');
    submitMessage('first');
    applySessionFrame('s1', { type: 'agent_start' });
    submitMessage('second');
    expect((sent[1].frame as Frame).type).toBe('steer');
    expect(sessionStoreFor('s1').state.entries).toHaveLength(2);
  });

  it('send image payloads for prompts, steering, and follow-ups', () => {
    setActiveSession('s1');
    const images = [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }];
    submitMessage('first', images);
    applySessionFrame('s1', { type: 'agent_start' });
    submitMessage('second', images);
    queueFollowUp('later', images);
    expect(sent.map((item) => item.frame)).toEqual([
      { type: 'prompt', message: 'first', images },
      { type: 'steer', message: 'second', images },
      { type: 'follow_up', message: 'later', images },
    ]);
  });
  it('take an explicit session id past the focus', () => {
    setActiveSession('s1');
    abortRun('s2');
    expect(sent).toEqual([{ type: 'session_command', sessionId: 's2', frame: { type: 'abort' } }]);
  });

  it('refuse to send blank drafts', () => {
    setActiveSession('s1');
    submitMessage('   ');
    queueFollowUp('  ');
    expect(sent).toHaveLength(0);
  });

  it('queue a follow-up', () => {
    setActiveSession('s1');
    queueFollowUp('later');
    expect((sent[0].frame as Frame).type).toBe('follow_up');
  });

  it('ask for every fact the rail shows', () => {
    refreshSessionFacts('s1');
    expect(sent.map((frame) => (frame.frame as Frame).type)).toEqual([
      'get_state',
      'get_session_stats',
      'get_commands',
    ]);
    expect(sent.every((frame) => frame.sessionId === 's1')).toBe(true);
  });

  it('ask for the picker lists, and re-read what a pick changes', () => {
    setActiveSession('s1');
    loadModelChoices();
    selectModel('openai', 'gpt-5.6');
    selectThinkingLevel('high');
    expect(sent.map((frame) => frame.frame)).toEqual([
      { type: 'get_available_models' },
      { type: 'get_available_thinking_levels' },
      { type: 'set_model', provider: 'openai', modelId: 'gpt-5.6' },
      { type: 'get_state' },
      { type: 'get_available_thinking_levels' },
      { type: 'set_thinking_level', level: 'high' },
      { type: 'get_state' },
    ]);
    expect(sent.every((frame) => frame.sessionId === 's1')).toBe(true);
  });

  it('invoke a command as a slash prompt, adding the slash when needed', () => {
    setActiveSession('s1');
    runCommand('domains');
    runCommand('/mode');
    expect(sent.map((frame) => (frame.frame as Frame).message)).toEqual(['/domains', '/mode']);
  });

  it('answer dialogs on the session that asked', () => {
    setActiveSession('s1');
    applySessionFrame('s1', { type: 'extension_ui_request', id: 'r1', method: 'select', options: ['a'] });
    answerDialogValue('r1', 'a');
    expect(sent[0]).toEqual({
      type: 'session_command',
      sessionId: 's1',
      frame: { type: 'extension_ui_response', id: 'r1', value: 'a' },
    });
    expect(sessionStoreFor('s1').state.dialog).toBeNull();

    applySessionFrame('s1', { type: 'extension_ui_request', id: 'r2', method: 'confirm' });
    answerDialogConfirm('r2', true);
    expect(sessionStoreFor('s1').state.dialog).toBeNull();

    applySessionFrame('s1', { type: 'extension_ui_request', id: 'r3', method: 'input' });
    cancelDialog('r3');
    const last = sent.at(-1) as Frame;
    expect((last.frame as Frame).cancelled).toBe(true);
    expect(sessionStoreFor('s1').state.dialog).toBeNull();
  });
});

describe('transient tabs', () => {
  beforeEach(() => resetTransientTabs());

  it('opens once per id, closes, and leaves with its session', () => {
    const Panel = (): null => null;
    const tab = { id: 'owner-x-1', label: 'x', panel: Panel };
    openTransientTab('s1', tab);
    openTransientTab('s1', { ...tab, label: 'replaced' });
    openTransientTab('s2', { id: 'owner-y-1', label: 'y', panel: Panel });
    expect(transientTabsOf(transientTabsStore.state, 's1')).toEqual([tab]);
    expect(findTransientTab(transientTabsStore.state, 's1', 'owner-x-1')).toBe(tab);
    expect(findTransientTab(transientTabsStore.state, 's1', 'owner-y-1')).toBeUndefined();
    expect(findTransientTab(transientTabsStore.state, undefined, 'owner-x-1')).toBeUndefined();

    const before = transientTabsStore.state;
    closeTransientTab('s1', 'nope');
    expect(transientTabsStore.state).toBe(before);
    closeTransientTab('s1', 'owner-x-1');
    expect(transientTabsOf(transientTabsStore.state, 's1')).toEqual([]);

    dropTransientTabs('s2');
    expect(transientTabsOf(transientTabsStore.state, 's2')).toEqual([]);
    // Nothing focused and nothing opened read as the one stable empty list.
    expect(transientTabsOf(transientTabsStore.state, null)).toBe(transientTabsOf(transientTabsStore.state, 'never'));
  });
});

describe('thread holds', () => {
  beforeEach(() => resetThreads());

  it('subscribes once per thread, replays holds on a fresh socket, and drops with the session', () => {
    const sent: object[] = [];
    bindTransport((frame) => sent.push(frame));
    subscribeThread('s1', 'run-1');
    subscribeThread('s1', 'run-1');
    subscribeThread('s2', 'run-9');
    expect(sent).toEqual([
      { type: 'subscribe_thread', sessionId: 's1', threadId: 'run-1' },
      { type: 'subscribe_thread', sessionId: 's2', threadId: 'run-9' },
    ]);
    unsubscribeThread('s1', 'run-1');
    expect(sent).toHaveLength(2);

    sent.length = 0;
    resubscribeThreads();
    expect(sent.map((frame) => (frame as { threadId: string }).threadId)).toEqual(['run-1', 'run-9']);

    sent.length = 0;
    dropThreads('s2');
    expect(heldThreads()).toEqual([{ sessionId: 's1', threadId: 'run-1', refs: 1 }]);
    unsubscribeThread('s1', 'run-1');
    expect(sent).toEqual([{ type: 'unsubscribe_thread', sessionId: 's1', threadId: 'run-1' }]);
    unsubscribeThread('s1', 'run-1');
    expect(sent).toHaveLength(1);
    expect(threadStoreKey('s1', 'run-1')).toBe('thread:s1:run-1');
    releaseTransport();
  });
});
