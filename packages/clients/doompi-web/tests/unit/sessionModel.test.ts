import { describe, expect, it } from 'vitest';
import {
  appendQueued,
  appendUserPrompt,
  clearDialog,
  imagesFromContent,
  initialSessionState,
  prependHistory,
  reduceSession,
  type AssistantEntry,
  type SessionState,
  type ToolEntry,
  summariseArgs,
  textFromContent,
} from '../../src/web/lib/sessionModel.ts';

const fold = (frames: Array<Record<string, unknown>>, from: SessionState = initialSessionState): SessionState =>
  frames.reduce((carried, frame) => reduceSession(carried, frame), from);

const assistant = (state: SessionState): AssistantEntry =>
  state.entries.find((entry) => entry.kind === 'assistant') as AssistantEntry;

const tool = (state: SessionState): ToolEntry => state.entries.find((entry) => entry.kind === 'tool') as ToolEntry;

describe('textFromContent', () => {
  it('joins text blocks and ignores everything else', () => {
    expect(textFromContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab');
  });

  it('passes a bare string through and tolerates junk', () => {
    expect(textFromContent('plain')).toBe('plain');
    expect(textFromContent(undefined)).toBe('');
    expect(textFromContent(42)).toBe('');
  });
});

describe('imagesFromContent', () => {
  it('keeps only complete image blocks with a supported MIME type', () => {
    expect(
      imagesFromContent([
        { type: 'image', data: 'cG5n', mimeType: 'image/png' },
        { type: 'image', data: 'c3Zn', mimeType: 'image/svg+xml' },
        { type: 'image', data: '', mimeType: 'image/jpeg' },
        { type: 'text', text: 'ignored' },
      ]),
    ).toEqual([{ data: 'cG5n', mimeType: 'image/png' }]);
  });
});

describe('summariseArgs', () => {
  it('prefers the argument a reader would recognise', () => {
    expect(summariseArgs({ command: 'ls -la', timeout: 5 })).toBe('ls -la');
    expect(summariseArgs({ file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts');
  });

  it('falls back to the key names, then to nothing', () => {
    expect(summariseArgs({ alpha: 1, beta: 2 })).toBe('alpha, beta');
    expect(summariseArgs({})).toBe('');
    expect(summariseArgs('nope')).toBe('');
  });
});

describe('reduceSession', () => {
  it.each([false, true])('shows journaled OAuth feedback once with protocol ownership %s', (transcriptFromProtocol) => {
    const frame = {
      type: 'entry_appended',
      entry: {
        type: 'custom',
        id: 'mcp-authorization-notice',
        customType: 'doom-notification',
        data: {
          version: 1,
          title: 'Pi',
          subtitle: 'doompi',
          body: 'Could not authorize agiflow-mcp: Connection timeout after 30000ms',
          level: 'warning',
        },
      },
    };
    const state = reduceSession(initialSessionState, frame, { transcriptFromProtocol });
    expect(state.entries).toEqual([expect.objectContaining({ kind: 'notice', text: frame.entry.data.body })]);
    expect(reduceSession(state, frame, { transcriptFromProtocol }).entries).toHaveLength(1);
    expect(
      reduceSession(initialSessionState, {
        ...frame,
        entry: { ...frame.entry, data: { ...frame.entry.data, body: '' } },
      }).entries,
    ).toEqual([]);
  });

  it('ignores frames it does not model', () => {
    expect(reduceSession(initialSessionState, { type: 'something_new' })).toBe(initialSessionState);
  });

  it('removes a widget when its session clears the widget lines', () => {
    const visible = reduceSession(initialSessionState, {
      type: 'extension_ui_request',
      method: 'setWidget',
      widgetKey: 'workflow-mcp-progress',
      widgetLines: ['running'],
    });
    const cleared = reduceSession(visible, {
      type: 'extension_ui_request',
      method: 'setWidget',
      widgetKey: 'workflow-mcp-progress',
    });

    expect(visible.widgets).toEqual(['workflow-mcp-progress']);
    expect(cleared.widgets).toEqual([]);
  });

  it('streams assistant text into one entry', () => {
    const state = fold([
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } },
    ]);

    expect(state.streaming).toBe(true);
    expect(state.entries).toHaveLength(1);
    expect(assistant(state).text).toBe('Hello world');
    expect(assistant(state).streaming).toBe(true);
  });

  it('keeps thinking separate from the answer', () => {
    const state = fold([
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'weighing options' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
    ]);

    expect(assistant(state).thinking).toBe('weighing options');
    expect(assistant(state).text).toBe('done');
  });

  it('prefers the final message text when it is richer than the deltas', () => {
    const state = fold([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'par' } },
      { type: 'message_end', message: { content: [{ type: 'text', text: 'partial then whole' }] } },
    ]);

    expect(assistant(state).text).toBe('partial then whole');
    expect(assistant(state).streaming).toBe(false);
  });

  it('keeps the streamed text when the final message carries none', () => {
    const state = fold([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'streamed' } },
      { type: 'message_end', message: {} },
    ]);

    expect(assistant(state).text).toBe('streamed');
  });

  it('opens a fresh entry after one closes', () => {
    const state = fold([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } },
      { type: 'message_end', message: {} },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second' } },
    ]);

    expect(state.entries.filter((entry) => entry.kind === 'assistant')).toHaveLength(2);
  });

  it('tracks a tool call from start to result', () => {
    const state = fold([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'pnpm test' } },
      {
        type: 'tool_execution_update',
        toolCallId: 'c1',
        partialResult: { content: [{ type: 'text', text: 'running' }] },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        result: { content: [{ type: 'text', text: '11 passed' }] },
        isError: false,
      },
    ]);

    expect(tool(state)).toMatchObject({
      name: 'bash',
      argSummary: 'pnpm test',
      output: '11 passed',
      isError: false,
      running: false,
    });
  });

  it('keeps the raw call and result for a plugin renderer, partial first', () => {
    const start = fold([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts', offset: 3 } },
    ]);
    expect(tool(start).args).toEqual({ path: 'a.ts', offset: 3 });
    expect(tool(start).result).toBeNull();

    const partial = reduceSession(start, {
      type: 'tool_execution_update',
      toolCallId: 'c1',
      partialResult: { content: [{ type: 'text', text: 'half' }], details: { lines: 1 } },
    });
    expect(tool(partial).result).toEqual({ content: [{ type: 'text', text: 'half' }], details: { lines: 1 } });

    const done = reduceSession(partial, {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      result: {
        content: [
          { type: 'text', text: 'all' },
          { type: 'image', data: 'x' },
        ],
        details: { lines: 2 },
      },
      isError: false,
    });
    expect(tool(done).result).toEqual({
      content: [
        { type: 'text', text: 'all' },
        { type: 'image', data: 'x' },
      ],
      details: { lines: 2 },
    });
    expect(tool(done).output).toBe('all');
  });

  it('tolerates a tool start without args and a result without content', () => {
    const state = fold([
      { type: 'tool_execution_start', toolCallId: 'c9', toolName: 'read' },
      { type: 'tool_execution_end', toolCallId: 'c9', result: { details: 'only' }, isError: false },
    ]);
    expect(tool(state).args).toEqual({});
    expect(tool(state).result).toEqual({ content: [], details: 'only' });
  });

  it('marks a failing tool call', () => {
    const state = fold([
      { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'bash', args: {} },
      { type: 'tool_execution_end', toolCallId: 'c2', result: {}, isError: true },
    ]);

    expect(tool(state).isError).toBe(true);
  });

  it('ignores tool updates for a call it never saw', () => {
    const state = reduceSession(initialSessionState, { type: 'tool_execution_end', toolCallId: 'ghost', result: {} });
    expect(state.entries).toHaveLength(0);
  });

  it('tracks a live protocol tool outside the authoritative transcript until it ends', () => {
    const started = reduceSession(
      initialSessionState,
      { type: 'tool_execution_start', toolCallId: 'live-1', toolName: 'ask_user_question', args: { questions: [] } },
      { transcriptFromProtocol: true },
    );

    expect(started.entries).toEqual([]);
    expect(started.activeTools).toMatchObject([
      { toolCallId: 'live-1', name: 'ask_user_question', args: { questions: [] }, running: true },
    ]);

    const ended = reduceSession(
      started,
      { type: 'tool_execution_end', toolCallId: 'live-1', result: { content: [] } },
      { transcriptFromProtocol: true },
    );
    expect(ended.activeTools).toEqual([]);
  });

  it('closes the open answer when a tool starts, so output is not appended to it', () => {
    const state = fold([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'calling a tool' } },
      { type: 'tool_execution_start', toolCallId: 'c3', toolName: 'read', args: {} },
    ]);

    expect(assistant(state).streaming).toBe(false);
  });

  it('settles the run and clears run-owned input', () => {
    let active = reduceSession(initialSessionState, { type: 'agent_start' });
    active = reduceSession(
      active,
      { type: 'tool_execution_start', toolCallId: 'call-ask', toolName: 'ask_user_question', args: {} },
      { transcriptFromProtocol: true },
    );
    active = reduceSession(active, {
      type: 'extension_ui_request',
      id: 'request-ask',
      method: 'select',
      options: ['continue'],
    });
    expect(active.dialog).not.toBeNull();
    expect(active.activeTools).toMatchObject([{ toolCallId: 'call-ask' }]);

    const state = reduceSession(active, { type: 'agent_settled' }, { transcriptFromProtocol: true });

    expect(state.streaming).toBe(false);
    expect(state.settled).toBe(true);
    expect(state.activeTools).toEqual([]);
    expect(state.dialog).toBeNull();
  });

  it('unwraps replayed frames', () => {
    const state = reduceSession(initialSessionState, {
      type: 'replay',
      frame: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'missed' } },
    });

    expect(assistant(state).text).toBe('missed');
  });

  it('ignores a replay envelope with no frame', () => {
    expect(reduceSession(initialSessionState, { type: 'replay' })).toBe(initialSessionState);
  });

  it('reads the agent facts out of get_state', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'get_state',
      data: {
        model: { id: 'gpt-5.3' },
        thinkingLevel: 'high',
        sessionId: 'abc',
        sessionName: 'work',
        messageCount: 3,
        isStreaming: true,
      },
    });

    expect(state.agent).toEqual({
      model: 'gpt-5.3',
      provider: '',
      thinkingLevel: 'high',
      sessionId: 'abc',
      sessionName: 'work',
      messageCount: 3,
      isStreaming: true,
    });
  });

  it('survives a get_state with no model', () => {
    const state = reduceSession(initialSessionState, { type: 'response', command: 'get_state', data: {} });
    expect(state.agent?.model).toBe('unknown');
  });

  it('keeps the provider get_state names, so a pick can address the same model', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'get_state',
      data: { model: { id: 'gpt-5.6', provider: 'openai' }, thinkingLevel: 'high' },
    });
    expect(state.agent?.provider).toBe('openai');
  });

  it('lists the models and thinking levels the session offers, dropping malformed ones', () => {
    const state = fold([
      {
        type: 'response',
        command: 'get_available_models',
        data: {
          models: [
            { provider: 'openai', id: 'gpt-5.6', name: 'GPT 5.6', reasoning: true, api: 'x' },
            { provider: 'anthropic', id: 'claude-opus-5' },
            { id: 'no-provider' },
            'junk',
          ],
        },
      },
      { type: 'response', command: 'get_available_thinking_levels', data: { levels: ['off', 'high', 7] } },
    ]);

    expect(state.models).toEqual([
      { provider: 'openai', id: 'gpt-5.6', name: 'GPT 5.6', reasoning: true },
      { provider: 'anthropic', id: 'claude-opus-5', name: 'claude-opus-5', reasoning: false },
    ]);
    expect(state.thinkingLevels).toEqual(['off', 'high']);
  });

  it('moves the chip to the model a set_model reply confirms', () => {
    const state = fold([
      { type: 'response', command: 'get_state', data: { model: { id: 'a', provider: 'p' }, thinkingLevel: 'low' } },
      { type: 'response', command: 'set_model', success: true, data: { id: 'b', provider: 'q', name: 'B' } },
    ]);

    expect(state.agent).toMatchObject({ model: 'b', provider: 'q', thinkingLevel: 'low' });
  });

  it('ignores a set_model reply before the agent facts exist', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'set_model',
      success: true,
      data: { id: 'b', provider: 'q' },
    });
    expect(state).toBe(initialSessionState);
  });

  it('surfaces a refused pick as an error notice, and stays quiet for other refusals', () => {
    const refused = reduceSession(initialSessionState, {
      type: 'response',
      command: 'set_model',
      success: false,
      error: 'Model not found: openai/nope',
    });
    expect(refused.entries).toEqual([
      { kind: 'notice', id: 'n1', text: 'Model not found: openai/nope', tone: 'error' },
    ]);

    const bare = reduceSession(initialSessionState, {
      type: 'response',
      command: 'set_thinking_level',
      success: false,
    });
    expect(bare.entries[0]).toMatchObject({ kind: 'notice', text: 'The agent refused set_thinking_level.' });

    expect(reduceSession(initialSessionState, { type: 'response', command: 'get_state', success: false })).toBe(
      initialSessionState,
    );
  });

  it('restores the selected prompt after tree navigation and surfaces a refusal', () => {
    const rewound = reduceSession(initialSessionState, {
      type: 'response',
      command: 'navigate_tree',
      success: true,
      data: { leafId: 'parent-1', editorText: 'revise this prompt', cancelled: false },
    });
    expect(rewound.editorTextRequest).toEqual({ id: 'rewind:parent-1:1', text: 'revise this prompt' });

    const refused = reduceSession(initialSessionState, {
      type: 'response',
      command: 'navigate_tree',
      success: false,
      error: 'Wait for the current response to finish before navigating the session tree.',
    });
    expect(refused.entries[0]).toMatchObject({ kind: 'notice', tone: 'error' });
  });

  it('reads usage out of get_session_stats', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'get_session_stats',
      data: {
        tokens: { total: 105_000 },
        cost: 0.84,
        contextUsage: { tokens: 82_400, contextWindow: 200_000, percent: 41 },
      },
    });

    expect(state.stats).toEqual({
      cost: 0.84,
      totalTokens: 105_000,
      contextPercent: 41,
      contextTokens: 82_400,
      contextWindow: 200_000,
    });
  });

  it('leaves context null when the session omits it', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'get_session_stats',
      data: { tokens: {}, cost: 0 },
    });

    expect(state.stats?.contextPercent).toBeNull();
  });

  it('keeps only well-formed commands', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'get_commands',
      data: { commands: [{ name: 'mode', description: 'pick' }, { description: 'no name' }, 'junk'] },
    });

    expect(state.commands).toEqual([
      { name: 'mode', description: 'pick' },
      { name: 'compact', description: 'Manually compact the session context' },
    ]);
  });

  it('lets an extension keep a name a built-in also claims', () => {
    const state = reduceSession(initialSessionState, {
      type: 'response',
      command: 'get_commands',
      data: { commands: [{ name: 'compact', description: 'the extension one' }] },
    });

    expect(state.commands).toEqual([{ name: 'compact', description: 'the extension one' }]);
  });

  it('ignores responses with no data and unknown commands', () => {
    expect(reduceSession(initialSessionState, { type: 'response', command: 'get_state' })).toBe(initialSessionState);
    expect(reduceSession(initialSessionState, { type: 'response', command: 'other', data: {} })).toBe(
      initialSessionState,
    );
  });

  it('captures a dialog request and drops an unknown method', () => {
    const opened = reduceSession(initialSessionState, {
      type: 'extension_ui_request',
      id: 'r1',
      method: 'select',
      title: 'pick one',
      options: ['a', 'b'],
    });
    expect(opened.dialog).toMatchObject({ id: 'r1', method: 'select', options: ['a', 'b'] });
    expect(clearDialog(opened).dialog).toBeNull();

    expect(reduceSession(initialSessionState, { type: 'extension_ui_request', method: 'theme' }).dialog).toBeNull();
  });

  it('defaults a dialog title and tolerates missing options', () => {
    const state = reduceSession(initialSessionState, { type: 'extension_ui_request', id: 'r2', method: 'input' });
    expect(state.dialog?.title).toBe('The agent needs an answer');
    expect(state.dialog?.options).toEqual([]);
  });

  it('keeps the latest extension editor replacement for the composer', () => {
    const state = reduceSession(initialSessionState, {
      type: 'extension_ui_request',
      id: 'voice-result-1',
      method: 'set_editor_text',
      text: 'transcribed in the browser',
    });

    expect(state.editorTextRequest).toEqual({ id: 'voice-result-1', text: 'transcribed in the browser' });
  });

  it('keeps the minor-mode catalog the runtime journals and ignores other custom entries', () => {
    const projection = { version: 1, revision: 2, modes: [{ id: 'help', label: 'Help', activation: 'active' }] };
    const reported = reduceSession(initialSessionState, {
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'doom-minor-modes', data: projection },
    });
    expect(reported.minorModes).toEqual(projection);

    const other = reduceSession(reported, {
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'agent-harness-plan-mode', data: { version: 2 } },
    });
    expect(other.minorModes).toEqual(projection);
    expect(reduceSession(initialSessionState, { type: 'entry_appended', entry: 'junk' }).minorModes).toBeNull();
  });

  it('closes only the matching dialog when the hub reports it answered', () => {
    const opened = reduceSession(initialSessionState, {
      type: 'extension_ui_request',
      id: 'r1',
      method: 'select',
      options: ['a'],
    });
    expect(reduceSession(opened, { type: 'extension_ui_answered', id: 'other' }).dialog).not.toBeNull();
    expect(reduceSession(opened, { type: 'extension_ui_answered', id: 'r1' }).dialog).toBeNull();
    // Replay order: an answered request opens and closes again, ending shut.
    const replayed = [
      { type: 'extension_ui_request', id: 'r1', method: 'select', options: ['a'] },
      { type: 'extension_ui_answered', id: 'r1' },
    ].reduce((carried, frame) => reduceSession(carried, frame), initialSessionState);
    expect(replayed.dialog).toBeNull();
  });

  it('records errors as notices', () => {
    const state = fold([
      { type: 'error', message: 'provider refused' },
      { type: 'extension_error', error: 'extension blew up' },
      { type: 'error' },
    ]);

    const notices = state.entries.filter((entry) => entry.kind === 'notice');
    expect(notices.map((entry) => entry.text)).toEqual([
      'provider refused',
      'extension blew up',
      'The agent reported an error.',
    ]);
  });

  it('records the prompt locally because Pi does not echo it', () => {
    const state = appendUserPrompt(initialSessionState, 'do the thing');
    expect(state.entries[0]).toMatchObject({ kind: 'user', text: 'do the thing' });
  });

  it('retains supported images on an optimistic prompt', () => {
    const images = [{ data: 'cG5n', mimeType: 'image/png' }];
    const state = appendUserPrompt(initialSessionState, 'review this', images);
    expect(state.entries[0]).toMatchObject({ kind: 'user', text: 'review this', images });
    expect(state.pendingUserEntries[0]).toMatchObject({ text: 'review this', images });
  });
});

describe('agent notifications', () => {
  it('renders notify requests as timeline notices with their tone', () => {
    let state = initialSessionState;
    state = reduceSession(state, {
      type: 'extension_ui_request',
      id: 'n1',
      method: 'notify',
      message: 'Major mode minimal is pending; the current process remains active.',
      notifyType: 'info',
    });
    state = reduceSession(state, {
      type: 'extension_ui_request',
      id: 'n2',
      method: 'notify',
      message: 'The switch failed.',
      notifyType: 'error',
    });
    const notices = state.entries.filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ tone: 'info', text: expect.stringContaining('minimal is pending') });
    expect(notices[1]).toMatchObject({ tone: 'error' });
    // A notify never opens a dialog.
    expect(state.dialog).toBeNull();
  });
});

describe('restoring a journalled transcript', () => {
  const journal = (id: string, message: Record<string, unknown>) => ({
    type: 'entry_appended',
    entry: { type: 'message', id, message },
  });

  it('folds journalled messages into the timeline the live stream would have built', () => {
    let state = initialSessionState;
    state = reduceSession(
      state,
      journal('e1', { role: 'user', content: [{ type: 'text', text: 'summarise the diff' }] }),
    );
    state = reduceSession(
      state,
      journal('e2', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'checking the tree' },
          { type: 'text', text: 'running git status' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'git status' } },
        ],
      }),
    );
    state = reduceSession(
      state,
      journal('e3', {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'M src/index.ts' }],
        details: { exitCode: 0 },
        isError: false,
      }),
    );

    expect(state.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool']);
    const [user, assistant, tool] = state.entries;
    expect(user).toMatchObject({ kind: 'user', text: 'summarise the diff' });
    // A restored reply is finished, so it must not wear the streaming cursor.
    expect(assistant).toMatchObject({
      kind: 'assistant',
      text: 'running git status',
      thinking: 'checking the tree',
      streaming: false,
    });
    expect(tool).toMatchObject({
      kind: 'tool',
      toolCallId: 'call-1',
      name: 'bash',
      argSummary: 'git status',
      output: 'M src/index.ts',
      isError: false,
      running: false,
    });
  });

  it('restores supported images from journalled user content', () => {
    const state = reduceSession(
      initialSessionState,
      journal('e1', {
        role: 'user',
        content: [
          { type: 'text', text: 'review this' },
          { type: 'image', data: 'cG5n', mimeType: 'image/png' },
          { type: 'image', data: 'c3Zn', mimeType: 'image/svg+xml' },
        ],
      }),
    );

    expect(state.entries[0]).toEqual({
      kind: 'user',
      id: 'u1',
      text: 'review this',
      images: [{ data: 'cG5n', mimeType: 'image/png' }],
    });
  });

  it('marks a call whose result never came as still running, and a failed one as an error', () => {
    let state = reduceSession(
      initialSessionState,
      journal('e1', {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'sleep 100' } }],
      }),
    );
    expect(state.entries[0]).toMatchObject({ kind: 'tool', running: true });

    state = reduceSession(
      state,
      journal('e2', {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      }),
    );
    expect(state.entries[0]).toMatchObject({ kind: 'tool', running: false, isError: true, output: 'boom' });
  });

  it('folds each journal entry once, so a re-attach does not double the transcript', () => {
    const entry = journal('e1', { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    let state = reduceSession(initialSessionState, entry);
    state = reduceSession(state, entry);
    state = reduceSession(state, entry);

    expect(state.entries).toHaveLength(1);
    expect(state.restoredIds).toEqual(['e1']);
  });

  it('leaves the runtime bookkeeping entries alone', () => {
    // A custom entry that is not the minor-mode catalog belongs to some
    // extension and has no place in the transcript.
    const state = reduceSession(initialSessionState, {
      type: 'entry_appended',
      entry: { type: 'custom', id: 'e1', customType: 'someone-elses-state', data: {} },
    });
    expect(state.entries).toHaveLength(0);
    expect(state.restoredIds).toEqual([]);
  });
});

describe('a message the page did not send', () => {
  const journalUser = (id: string, text: string) => ({
    type: 'entry_appended',
    entry: { type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } },
  });
  const texts = (state: SessionState) => state.entries.map((entry) => [entry.kind, 'text' in entry ? entry.text : '']);

  it('shows a prompt an extension sent on your behalf, which reaches the page only as a journal entry', () => {
    // Autonomous voice dictates what it heard straight to the agent, so no
    // frame carries the text; without the journal the turn looks like it
    // answered nothing.
    const state = reduceSession(initialSessionState, journalUser('e1', 'what is failing'));
    expect(texts(state)).toEqual([['user', 'what is failing']]);
  });

  it('folds the journal copy of a prompt this page sent into the entry already on screen', () => {
    let state = appendUserPrompt(initialSessionState, 'run the tests');
    expect(texts(state)).toEqual([['user', 'run the tests']]);
    // The hub re-reads the journal at every run boundary, so this arrives for
    // a message the page put up itself.
    state = reduceSession(state, journalUser('e1', 'run the tests'));
    expect(texts(state)).toEqual([['user', 'run the tests']]);
    expect(state.pendingUserEntries).toEqual([]);
  });

  it('settles a queued follow-up into a sent message when the run picks it up', () => {
    let state = appendQueued(initialSessionState, 'and then commit');
    expect(texts(state)).toEqual([['queued', 'and then commit']]);
    state = reduceSession(state, journalUser('e1', 'and then commit'));
    expect(texts(state)).toEqual([['user', 'and then commit']]);
  });

  it('reconciles one prompt per copy, so the same text sent twice shows twice', () => {
    let state = appendUserPrompt(initialSessionState, 'again');
    state = appendUserPrompt(state, 'again');
    state = reduceSession(state, journalUser('e1', 'again'));
    state = reduceSession(state, journalUser('e2', 'again'));
    expect(texts(state)).toEqual([
      ['user', 'again'],
      ['user', 'again'],
    ]);
    expect(state.pendingUserEntries).toEqual([]);
  });
});

describe('paging back through the transcript', () => {
  const journalled = (id: string, text: string) => ({
    type: 'entry_appended',
    entry: { type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } },
  });

  it('puts an older window above what the page already holds', () => {
    const live = fold([journalled('e3', 'newest')]);

    const next = prependHistory(live, [journalled('e1', 'oldest'), journalled('e2', 'middle')], 1);

    expect(next.entries.map((entry) => (entry.kind === 'user' ? entry.text : entry.kind))).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('keys prepended entries apart from the live ones, so a list can measure them', () => {
    const live = fold([journalled('e2', 'newest')]);

    const next = prependHistory(live, [journalled('e1', 'oldest')], 1);

    expect(new Set(next.entries.map((entry) => entry.id)).size).toBe(next.entries.length);
    expect(next.entries[0]?.id.startsWith('h1-')).toBe(true);
  });

  it('ignores a window the page already holds, so a repeated answer cannot double it', () => {
    const live = fold([journalled('e1', 'oldest'), journalled('e2', 'newest')]);

    const next = prependHistory(live, [journalled('e1', 'oldest')], 1);

    expect(next).toBe(live);
  });

  it('remembers what it restored, so the next window knows where it stopped', () => {
    const next = prependHistory(initialSessionState, [journalled('e1', 'oldest')], 1);

    expect(next.restoredIds).toContain('e1');
  });
});
