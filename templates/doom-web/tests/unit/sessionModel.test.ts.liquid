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
