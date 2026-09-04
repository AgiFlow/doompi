import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/types/hub.ts';
import {
  abortCommand,
  clearQueueCommand,
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
import {
  bindTransport,
  notifyHubConnected,
  onHubConnected,
  releaseTransport,
  sendFrame,
  sendHubFrame,
} from '../../src/web/lib/transport.ts';
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
  applyProtocolQueue,
  applyProtocolTranscript,
  applySessionFrame,
  cancelDialog,
  clearQueuedMessages,
  deleteQueuedMessage,
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
  rewindToMessage,
  sessionStoreFor,
  submitMessage,
} from '../../src/web/stores/sessionStore.ts';
import {
  applySessionBacklog,
  applySessionRemoved,
  applySessionsSnapshot,
  applySessionUpsert,
  beginSessionTransfer,
  completeSessionTransfer,
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
    expect(clearQueueCommand()).toEqual({ type: 'clear_queue' });
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

  it('keeps an optimistic prompt and its images until the protocol publishes it', () => {
    const rpcImages = [{ type: 'image' as const, data: 'bG9jYWw=', mimeType: 'image/png' }];
    const userImages = [{ data: 'bG9jYWw=', mimeType: 'image/png' }];
    setActiveSession('s1');
    submitMessage('stay visible', rpcImages);
    const optimisticId = sessionStoreFor('s1').state.entries[0]?.id;

    applyProtocolTranscript('s1', [], false);
    expect(sessionStoreFor('s1').state.entries).toEqual([
      expect.objectContaining({ kind: 'user', text: 'stay visible', images: userImages }),
    ]);

    const authoritativeImages = [{ data: 'cHVibGlzaGVk', mimeType: 'image/png' }];
    applyProtocolTranscript(
      's1',
      [{ kind: 'user', id: 'protocol-user', text: 'stay visible', images: authoritativeImages }],
      false,
    );
    expect(sessionStoreFor('s1').state.entries).toEqual([
      { kind: 'user', id: optimisticId, text: 'stay visible', images: authoritativeImages },
    ]);
  });

  it('keeps one stable prompt entry when the settled transcript publishes it', () => {
    applyProtocolTranscript('s1', [], true);
    setActiveSession('s1');
    submitMessage('stay in place');
    const optimisticId = sessionStoreFor('s1').state.entries[0]?.id;

    applySessionFrame('s1', { type: 'agent_settled' });
    applyProtocolTranscript('s1', [{ kind: 'user', id: 'protocol-user', text: 'stay in place' }], false);

    expect(sessionStoreFor('s1').state.entries).toEqual([
      { kind: 'user', id: optimisticId, text: 'stay in place' },
      expect.objectContaining({ kind: 'settled' }),
    ]);

    applyProtocolTranscript('s1', [{ kind: 'user', id: 'protocol-user', text: 'stay in place' }], false);
    expect(sessionStoreFor('s1').state.entries.filter((entry) => entry.kind === 'user')).toEqual([
      { kind: 'user', id: optimisticId, text: 'stay in place' },
    ]);
  });

  it('keeps an optimistic command where it was submitted as later protocol activity arrives', () => {
    applyProtocolTranscript(
      's1',
      [{ kind: 'assistant', id: 'assistant-1', text: 'before', thinking: '', streaming: true }],
      true,
    );
    setActiveSession('s1');
    submitMessage('/minor voice-auto');

    applyProtocolTranscript(
      's1',
      [
        { kind: 'assistant', id: 'assistant-1', text: 'before', thinking: '', streaming: false },
        {
          kind: 'tool',
          id: 'tool-1',
          toolCallId: 'tool-1',
          name: 'narrate',
          args: {},
          argSummary: '',
          result: null,
          output: '',
          isError: false,
          running: true,
        },
      ],
      true,
    );

    expect(sessionStoreFor('s1').state.entries.map((entry) => entry.id)).toEqual([
      'assistant-1',
      expect.stringMatching(/^u/),
      'tool-1',
    ]);
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

  it('folds the journalled copy of a published prompt after ownership returns to the journal', () => {
    // The protocol claims the optimistic prompt, then its socket drops and the
    // journal reports the same message. Without the claim record that copy
    // reads as a new prompt and lands below the settled divider, which is the
    // reader's own message recapped after the agent has finished.
    applyProtocolTranscript('s1', [], true);
    setActiveSession('s1');
    submitMessage('say it once');
    const optimisticId = sessionStoreFor('s1').state.entries[0]?.id;
    applyProtocolTranscript('s1', [{ kind: 'user', id: 'protocol-user', text: 'say it once' }], true);
    applySessionFrame('s1', { type: 'agent_settled' });

    releaseProtocolTranscript('s1');
    applySessionFrame('s1', {
      type: 'entry_appended',
      entry: {
        id: 'journal-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'say it once' }] },
      },
    });

    expect(sessionStoreFor('s1').state.entries).toEqual([
      { kind: 'user', id: optimisticId, text: 'say it once' },
      expect.objectContaining({ kind: 'settled' }),
    ]);
  });

  it('folds every re-published copy of a prompt into the entry that stands', () => {
    // The hub re-reads the journal at each run boundary and re-publishes user
    // messages, because no live frame carries one. A claim consumed by the first
    // of those copies left the next one reading as a new prompt, which is the
    // reader's own message appearing again below the settled divider.
    applyProtocolTranscript('s1', [], true);
    setActiveSession('s1');
    submitMessage('say it once');
    const optimisticId = sessionStoreFor('s1').state.entries[0]?.id;
    applyProtocolTranscript('s1', [{ kind: 'user', id: 'protocol-user', text: 'say it once' }], true);
    applySessionFrame('s1', { type: 'agent_settled' });
    releaseProtocolTranscript('s1');

    for (const id of ['journal-1', 'journal-2']) {
      applySessionFrame('s1', {
        type: 'entry_appended',
        entry: { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'say it once' }] } },
      });
    }

    expect(sessionStoreFor('s1').state.entries).toEqual([
      { kind: 'user', id: optimisticId, text: 'say it once' },
      expect.objectContaining({ kind: 'settled' }),
    ]);
  });

  it('remembers a journalled prompt it dropped, so the same entry cannot arrive again', () => {
    // While the protocol owns the transcript the journal's copy is dropped. The
    // id is kept all the same: the hub republishes that entry at the next run
    // boundary, and by then ownership may have returned to the journal.
    applyProtocolTranscript('s1', [], true);
    setActiveSession('s1');
    submitMessage('say it once');
    const optimisticId = sessionStoreFor('s1').state.entries[0]?.id;
    applyProtocolTranscript('s1', [{ kind: 'user', id: 'protocol-user', text: 'say it once' }], true);
    const journalled = {
      type: 'entry_appended',
      entry: {
        id: 'journal-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'say it once' }] },
      },
    };
    applySessionFrame('s1', journalled);
    applySessionFrame('s1', { type: 'agent_settled' });

    releaseProtocolTranscript('s1');
    applySessionFrame('s1', journalled);

    expect(sessionStoreFor('s1').state.entries).toEqual([
      { kind: 'user', id: optimisticId, text: 'say it once' },
      expect.objectContaining({ kind: 'settled' }),
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
    expect(sent).toEqual([{ type: 'subscribe', sessionId: 's1' }]);
  });

  it('notifies hub connection subscribers until they unsubscribe', () => {
    let connections = 0;
    const unsubscribe = onHubConnected(() => (connections += 1));

    notifyHubConnected();
    notifyHubConnected();
    unsubscribe();
    notifyHubConnected();

    expect(connections).toBe(2);
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

  it('tracks a transfer until that same session completes', () => {
    beginSessionTransfer('a');
    beginSessionTransfer('a');
    completeSessionTransfer('b');
    expect(sessionsStore.state.transferringToId).toBe('a');

    completeSessionTransfer('a');
    expect(sessionsStore.state.transferringToId).toBeNull();
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
    const selections: Array<[number, number]> = [];
    const input = {
      disabled: false,
      focus: () => (focused += 1),
      setSelectionRange: (start: number, end: number) => selections.push([start, end]),
    } as unknown as HTMLTextAreaElement;
    const release = registerPromptInput(input);
    focusPrompt(3);
    expect(focused).toBe(1);
    expect(selections).toEqual([[3, 3]]);

    let replacementFocused = 0;
    const replacement = {
      disabled: false,
      focus: () => (replacementFocused += 1),
      setSelectionRange: () => undefined,
    } as unknown as HTMLTextAreaElement;
    const releaseReplacement = registerPromptInput(replacement);
    release();
    focusPrompt();
    expect(replacementFocused).toBe(1);
    releaseReplacement();
    registerPromptInput(input);
    // A composer with no session behind it cannot take the caret.
    (input as unknown as { disabled: boolean }).disabled = true;
    focusPrompt();
    expect(focused).toBe(1);

    (input as unknown as { disabled: boolean }).disabled = false;
    const finalRelease = registerPromptInput(input);
    finalRelease();
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

  it('rewinds only a non-empty item in an addressed session', () => {
    rewindToMessage('', 's1');
    rewindToMessage('message-1', null);
    setActiveSession('s1');
    rewindToMessage('message-1');

    expect(sent).toEqual([
      { type: 'session_command', sessionId: 's1', frame: { type: 'rewind', itemId: 'message-1' } },
    ]);
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

  it('send image payloads for prompts, steering, and follow-ups and keep local copies visible', () => {
    setActiveSession('s1');
    const images = [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }];
    const userImages = [{ data: 'aGVsbG8=', mimeType: 'image/png' }];
    submitMessage('first', images);
    applySessionFrame('s1', { type: 'agent_start' });
    submitMessage('second', images);
    queueFollowUp('later', images);
    expect(sent.map((item) => item.frame)).toEqual([
      { type: 'prompt', message: 'first', images },
      { type: 'steer', message: 'second', images },
      { type: 'follow_up', message: 'later', images },
    ]);
    expect(sessionStoreFor('s1').state.entries).toMatchObject([
      { kind: 'user', text: 'first', images: userImages },
      { kind: 'user', text: 'second', images: userImages },
      { kind: 'queued', text: 'later', images: userImages },
    ]);
  });
  it('clears queued work before aborting an explicit session', () => {
    setActiveSession('s1');
    applySessionFrame('s2', { type: 'queue_update', steering: ['interrupt'], followUp: ['later'] });

    abortRun('s2');

    expect(sessionStoreFor('s2').state.entries.filter((entry) => entry.kind === 'queued')).toEqual([]);
    expect(sent).toEqual([
      { type: 'session_command', sessionId: 's2', frame: { type: 'clear_queue' } },
      { type: 'session_command', sessionId: 's2', frame: { type: 'abort' } },
    ]);
  });

  it('refuse to send blank drafts', () => {
    setActiveSession('s1');
    submitMessage('   ');
    queueFollowUp('  ');
    expect(sent).toHaveLength(0);
  });

  it('replaces local queue rows from legacy and protocol snapshots', () => {
    applySessionFrame('s1', { type: 'queue_update', steering: ['interrupt'], followUp: ['later'] });
    expect(sessionStoreFor('s1').state.entries).toMatchObject([
      { kind: 'queued', text: 'interrupt', delivery: 'steer' },
      { kind: 'queued', text: 'later', delivery: 'followUp' },
    ]);

    applyProtocolQueue('s1', [{ kind: 'queued', id: 'server-q1', text: 'after that' }]);
    expect(sessionStoreFor('s1').state.entries).toMatchObject([{ kind: 'queued', text: 'after that' }]);

    const settled = sessionStoreFor('s1').state;
    applyProtocolQueue('s1', [{ kind: 'queued', id: 'server-q2', text: 'after that' }]);
    expect(sessionStoreFor('s1').state).toBe(settled);
  });

  it('clears queued rows and asks Pi to delete its queue', () => {
    setActiveSession('s1');
    queueFollowUp('later');
    clearQueuedMessages();

    expect(sessionStoreFor('s1').state.entries.filter((entry) => entry.kind === 'queued')).toEqual([]);
    expect(sent.map((item) => item.frame)).toEqual([{ type: 'follow_up', message: 'later' }, { type: 'clear_queue' }]);
  });

  it('deletes one known queue row and restores the others through Pi clear_queue', () => {
    setActiveSession('s1');
    const images = [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }];
    queueFollowUp('first');
    queueFollowUp('second', images);
    const queued = sessionStoreFor('s1').state.entries.filter((entry) => entry.kind === 'queued');
    const first = queued[0];
    if (first === undefined) throw new Error('Expected the first queued entry.');

    deleteQueuedMessage(first.id, 3);
    expect(sent).toHaveLength(2);
    deleteQueuedMessage(first.id, 2);

    expect(sessionStoreFor('s1').state.entries.filter((entry) => entry.kind === 'queued')).toMatchObject([
      { text: 'second', delivery: 'followUp', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] },
    ]);
    expect(sent.map((item) => item.frame)).toEqual([
      { type: 'follow_up', message: 'first' },
      { type: 'follow_up', message: 'second', images },
      { type: 'clear_queue' },
      { type: 'follow_up', message: 'second', images },
    ]);
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

  it('send a built-in as its own frame rather than as prompt text', () => {
    setActiveSession('s1');
    runCommand('compact');
    submitMessage('/compact keep the API decisions');
    submitMessage('/compact\n\nfolded attachment text');
    submitMessage('/compaction is a word');
    submitMessage('/mode');
    submitMessage('read @src/a.ts and summarise it');
    expect(sent.map((frame) => frame.frame)).toEqual([
      { type: 'compact' },
      { type: 'compact', customInstructions: 'keep the API decisions' },
      { type: 'compact', customInstructions: 'folded attachment text' },
      { type: 'prompt', message: '/compaction is a word' },
      { type: 'prompt', message: '/mode' },
      { type: 'prompt', message: 'read @src/a.ts and summarise it' },
    ]);
    // The command is still echoed into the timeline, so the run has a cause.
    expect(sessionStoreFor('s1').state.entries).toEqual([
      expect.objectContaining({ kind: 'user', text: '/compact' }),
      expect.objectContaining({ kind: 'user', text: '/compact keep the API decisions' }),
      expect.objectContaining({ kind: 'user', text: '/compact\n\nfolded attachment text' }),
      expect.objectContaining({ kind: 'user', text: '/compaction is a word' }),
      expect.objectContaining({ kind: 'user', text: '/mode' }),
      expect.objectContaining({ kind: 'user', text: 'read @src/a.ts and summarise it' }),
    ]);
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
    const tab = { id: 'owner-x-1', label: 'x', panel: Panel, retainComposer: true };
    openTransientTab('s1', tab);
    openTransientTab('s1', { ...tab, label: 'replaced', retainComposer: false });
    openTransientTab('s2', { id: 'owner-y-1', label: 'y', panel: Panel });
    expect(transientTabsOf(transientTabsStore.state, 's1')).toEqual([tab]);
    expect(findTransientTab(transientTabsStore.state, 's1', 'owner-x-1')).toBe(tab);
    expect(findTransientTab(transientTabsStore.state, 's1', 'owner-x-1')?.retainComposer).toBe(true);
    expect(findTransientTab(transientTabsStore.state, 's2', 'owner-y-1')?.retainComposer).toBeUndefined();
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
