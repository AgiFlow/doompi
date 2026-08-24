import { describe, expect, it } from 'vitest';
import {
  appendUserPrompt,
  clearDialog,
  initialSessionState,
  reduceSession,
  type AssistantEntry,
  type SessionState,
  type ToolEntry,
  summariseArgs,
  textFromContent,
} from '../../src/web/lib/sessionModel.ts';

const fold = (frames: Array<Record<string, unknown>>, from: SessionState = initialSessionState): SessionState =>
  frames.reduce(reduceSession, from);

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
  it('ignores frames it does not model', () => {
    expect(reduceSession(initialSessionState, { type: 'something_new' })).toBe(initialSessionState);
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

  it('closes the open answer when a tool starts, so output is not appended to it', () => {
    const state = fold([
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'calling a tool' } },
      { type: 'tool_execution_start', toolCallId: 'c3', toolName: 'read', args: {} },
    ]);

    expect(assistant(state).streaming).toBe(false);
  });

  it('settles the run', () => {
    const state = fold([{ type: 'agent_start' }, { type: 'agent_settled' }]);
    expect(state.streaming).toBe(false);
    expect(state.settled).toBe(true);
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

    expect(state.commands).toEqual([{ name: 'mode', description: 'pick' }]);
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
    ].reduce(reduceSession, initialSessionState);
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
