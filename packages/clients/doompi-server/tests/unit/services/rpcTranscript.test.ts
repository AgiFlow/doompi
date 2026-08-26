import { encodeServerMessage } from '@earendil-works/pi-protocol';
import { describe, expect, it } from 'vitest';
import { createRpcTranscript, type RpcTranscript } from '../../../src/services/rpcTranscript.ts';
import type { SessionFrame } from '../../../src/types/session.ts';

/** A clock the assertions can predict. */
function transcript(): RpcTranscript {
  let tick = 0;
  return createRpcTranscript({ id: 'session-1', cwd: '/workspace/repo', now: () => (tick += 1) });
}

/**
 * Encoding through the real schema is the point of these tests.
 *
 * The protocol rejects unknown properties, non-finite numbers, and undefined,
 * so a projection that drifts fails here rather than at a client that already
 * dropped the connection.
 */
function assertEncodable(snapshot: unknown): void {
  expect(() =>
    encodeServerMessage({ type: 'event', event: { type: 'session_snapshot', snapshot: snapshot as never } }),
  ).not.toThrow();
}

function apply(subject: RpcTranscript, frames: SessionFrame[]): void {
  for (const frame of frames) subject.apply(frame);
}

describe('rpc transcript projection', () => {
  it('starts idle with an empty transcript the protocol accepts', () => {
    const snapshot = transcript().snapshot();

    expect(snapshot).toMatchObject({ id: 'session-1', phase: 'idle', revision: 0, transcript: [] });
    assertEncodable(snapshot);
  });

  it('tracks the phase across a turn', () => {
    const subject = transcript();

    expect(subject.apply({ type: 'agent_start' }).snapshot?.phase).toBe('turn');
    expect(subject.apply({ type: 'compaction_start' }).snapshot?.phase).toBe('compaction');
    expect(subject.apply({ type: 'auto_retry_start' }).snapshot?.phase).toBe('retry');
    expect(subject.apply({ type: 'agent_settled' }).snapshot?.phase).toBe('idle');
  });

  it('streams an assistant message as progress and commits it once', () => {
    const subject = transcript();
    const message = {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: { provider: 'anthropic', id: 'opus' },
    };

    const started = subject.apply({ type: 'message_start', message });
    const updated = subject.apply({
      type: 'message_update',
      message: { ...message, content: [{ type: 'text', text: 'hi there' }] },
    });

    // Nothing authoritative changes while a message is in flight.
    expect(started.snapshot).toBeUndefined();
    expect(updated.snapshot).toBeUndefined();
    expect(started.progress).toMatchObject({ type: 'item_started' });
    expect(subject.snapshot().transcript).toHaveLength(0);

    const ended = subject.apply({
      type: 'message_end',
      message: { ...message, content: [{ type: 'text', text: 'hi there' }], stopReason: 'stop' },
    });

    expect(ended.progress).toMatchObject({ type: 'item_finished' });
    expect(ended.snapshot?.transcript).toHaveLength(1);
    expect(ended.snapshot?.transcript[0]).toMatchObject({
      role: 'assistant',
      status: 'complete',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'hi there' }],
    });
    assertEncodable(ended.snapshot);
  });

  it('maps an aborted message onto the aborted status the schema requires', () => {
    const subject = transcript();
    apply(subject, [{ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }]);

    const ended = subject.apply({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content: [], stopReason: 'aborted' },
    });

    expect(ended.snapshot?.transcript[0]).toMatchObject({ status: 'aborted', stopReason: 'aborted' });
    assertEncodable(ended.snapshot);
  });

  it('carries a tool call through running, updated, and finished', () => {
    const subject = transcript();

    const started = subject.apply({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'read',
      args: { path: '/a.ts' },
    });
    const updated = subject.apply({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { lines: 3 } });
    const ended = subject.apply({
      type: 'tool_execution_end',
      toolCallId: 't1',
      result: { content: [{ type: 'text', text: 'ok' }], details: { anchors: ['5#abc'] } },
      isError: false,
    });

    expect(started.progress).toMatchObject({ type: 'item_started', item: { status: 'running', toolName: 'read' } });
    expect(updated.progress).toMatchObject({ item: { details: { lines: 3 } } });
    // DoomPi tool payloads ride `details`, the one open field on a tool item.
    expect(ended.snapshot?.transcript[0]).toMatchObject({
      role: 'tool',
      status: 'complete',
      isError: false,
      details: { anchors: ['5#abc'] },
      content: [{ type: 'text', text: 'ok' }],
    });
    assertEncodable(ended.snapshot);
  });

  it('marks a failed tool call as an error', () => {
    const subject = transcript();
    apply(subject, [{ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} }]);

    const ended = subject.apply({ type: 'tool_execution_end', toolCallId: 't1', result: {}, isError: true });

    expect(ended.snapshot?.transcript[0]).toMatchObject({ status: 'error', isError: true });
    assertEncodable(ended.snapshot);
  });

  it('ignores tool frames for a call it never saw start', () => {
    const subject = transcript();

    expect(subject.apply({ type: 'tool_execution_end', toolCallId: 'ghost', result: {} })).toEqual({});
    expect(subject.apply({ type: 'tool_execution_update', toolCallId: 'ghost' })).toEqual({});
  });

  it('appends a journalled user message once', () => {
    const subject = transcript();

    const result = subject.apply({
      type: 'entry_appended',
      entry: { id: 'e1', type: 'message', timestamp: 42, message: { role: 'user', content: 'do the thing' } },
    });

    expect(result.snapshot?.transcript[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
      timestamp: 42,
    });
    assertEncodable(result.snapshot);
  });

  it('leaves DoomPi journal entries to their own channel', () => {
    const subject = transcript();

    // A custom entry has no protocol shape; forcing one would fail encoding.
    expect(
      subject.apply({ type: 'entry_appended', entry: { type: 'custom', customType: 'minor-mode-catalog' } }),
    ).toEqual({});
    expect(subject.apply({ type: 'entry_appended', entry: { type: 'compaction' } })).toEqual({});
  });

  it('adopts model, thinking level, and phase from a state response', () => {
    const subject = transcript();

    const result = subject.apply({
      type: 'response',
      command: 'get_state',
      data: {
        model: { provider: 'anthropic', id: 'claude-opus-4-5' },
        thinkingLevel: 'high',
        isStreaming: true,
        isCompacting: false,
        sessionName: 'cockpit',
      },
    });

    expect(result.snapshot).toMatchObject({
      model: { provider: 'anthropic', id: 'claude-opus-4-5' },
      thinkingLevel: 'high',
      phase: 'turn',
      name: 'cockpit',
    });
    assertEncodable(result.snapshot);
  });

  it('publishes the steering queue as protocol user items', () => {
    const subject = transcript();

    const result = subject.apply({ type: 'queue_update', steering: ['first', 'second'], followUp: [] });

    expect(result.snapshot?.queuedSteerCount).toBe(2);
    expect(result.snapshot?.queuedSteer[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    assertEncodable(result.snapshot);
  });

  it('advances the revision on every authoritative change so clients never ignore one', () => {
    const subject = transcript();

    const first = subject.apply({ type: 'agent_start' }).snapshot?.revision ?? 0;
    const second = subject.apply({ type: 'agent_settled' }).snapshot?.revision ?? 0;

    expect(second).toBeGreaterThan(first);
  });

  it('strips values the protocol JSON subset rejects', () => {
    const subject = transcript();
    apply(subject, [{ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} }]);

    const ended = subject.apply({
      type: 'tool_execution_end',
      toolCallId: 't1',
      result: { details: { ok: true, missing: undefined, broken: Number.POSITIVE_INFINITY } },
    });

    expect(ended.snapshot?.transcript[0]).toMatchObject({ details: { ok: true, broken: null } });
    assertEncodable(ended.snapshot);
  });

  it('reduces an unknown frame to nothing rather than guessing', () => {
    expect(transcript().apply({ type: 'something_new', payload: 1 })).toEqual({});
  });

  it('carries thinking and tool-call parts of an assistant message', () => {
    const subject = transcript();
    const content = [
      { type: 'thinking', thinking: 'considering', redacted: true },
      { type: 'toolCall', id: 'c1', name: 'grep', arguments: { pattern: 'x' } },
      { type: 'unknown-part' },
    ];
    apply(subject, [{ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }]);

    const ended = subject.apply({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content, stopReason: 'toolUse' },
    });

    expect(ended.snapshot?.transcript[0]).toMatchObject({
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'considering', redacted: true },
        { type: 'toolCall', toolCallId: 'c1', toolName: 'grep', input: { pattern: 'x' } },
      ],
    });
    assertEncodable(ended.snapshot);
  });

  it('records a failed message as an error with its reason', () => {
    const subject = transcript();
    apply(subject, [{ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } }]);

    const ended = subject.apply({
      type: 'message_end',
      message: { id: 'm1', role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider refused' },
    });

    expect(ended.snapshot?.transcript[0]).toMatchObject({
      status: 'error',
      stopReason: 'error',
      errorMessage: 'provider refused',
    });
    assertEncodable(ended.snapshot);
  });

  it('commits a message whose start was never seen', () => {
    // A client attaching mid-turn misses the start but must still see the result.
    const subject = transcript();

    const ended = subject.apply({
      type: 'message_end',
      message: { id: 'm9', role: 'assistant', content: [], stopReason: 'stop' },
    });

    expect(ended.snapshot?.transcript).toHaveLength(1);
    assertEncodable(ended.snapshot);
  });

  it('ignores a delta for a message it is not tracking', () => {
    expect(
      transcript().apply({ type: 'message_update', message: { id: 'ghost', role: 'assistant', content: [] } }),
    ).toEqual({});
  });

  it('keeps the known model and level when a state response omits or corrupts them', () => {
    const subject = transcript();
    apply(subject, [
      {
        type: 'response',
        command: 'get_state',
        data: { model: { provider: 'anthropic', id: 'opus' }, thinkingLevel: 'high' },
      },
    ]);

    const result = subject.apply({ type: 'response', command: 'get_state', data: { thinkingLevel: 'nonsense' } });

    expect(result.snapshot?.thinkingLevel).toBe('high');
    expect(result.snapshot?.model).toEqual({ provider: 'unknown', id: 'unknown' });
  });

  it('ignores responses to commands with no protocol meaning, and malformed state', () => {
    const subject = transcript();

    expect(subject.apply({ type: 'response', command: 'get_commands', data: [] })).toEqual({});
    expect(subject.apply({ type: 'response', command: 'get_state', data: 'nope' })).toEqual({});
  });

  it('keeps the current name when the session reports an empty one', () => {
    const subject = transcript();

    const result = subject.apply({ type: 'session_info_changed', name: undefined });

    expect(result.snapshot?.name).toBeUndefined();
  });

  it('accepts image content on a user entry and drops parts it cannot represent', () => {
    const subject = transcript();

    const result = subject.apply({
      type: 'entry_appended',
      entry: {
        id: 'e1',
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'image', data: '' },
            { type: 'audio' },
          ],
        },
      },
    });

    expect(result.snapshot?.transcript[0]).toMatchObject({
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    });
    assertEncodable(result.snapshot);
  });

  it('ignores a user entry with nothing representable in it', () => {
    const subject = transcript();

    expect(
      subject.apply({ type: 'entry_appended', entry: { type: 'message', message: { role: 'user', content: [] } } }),
    ).toEqual({});
    expect(
      subject.apply({ type: 'entry_appended', entry: { type: 'message', message: { role: 'assistant' } } }),
    ).toEqual({});
    expect(subject.apply({ type: 'entry_appended' })).toEqual({});
  });

  it('keeps a prompt in the user voice, not the agent one', () => {
    // These frames carry whichever message started, including the user's. Read
    // as the assistant's, a prompt renders as something the agent said.
    const subject = transcript();
    const message = { role: 'user', content: 'testing', timestamp: 1700 };

    const started = subject.apply({ type: 'message_start', message });

    expect(started.snapshot?.transcript).toHaveLength(1);
    expect(started.snapshot?.transcript[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'testing' }],
    });
    assertEncodable(started.snapshot);
  });

  it('holds one copy of a prompt the agent both started and journalled', () => {
    const subject = transcript();
    const message = { role: 'user', content: 'testing', timestamp: 1700 };

    subject.apply({ type: 'message_start', message });
    const ended = subject.apply({ type: 'message_end', message });
    const journalled = subject.apply({ type: 'entry_appended', entry: { id: 'e1', type: 'message', message } });

    // Every later arrival is the same message, so none of them append again.
    expect(ended).toEqual({});
    expect(journalled).toEqual({});
    expect(subject.snapshot().transcript).toHaveLength(1);
  });

  it('leaves a tool result to the execution frames that carry the call too', () => {
    const subject = transcript();

    const result = subject.apply({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] },
    });

    expect(result).toEqual({});
    expect(subject.snapshot().transcript).toHaveLength(0);
  });

  it('ignores a message the agent reported without a role', () => {
    const subject = transcript();

    expect(subject.apply({ type: 'message_start', message: { id: 'm1', content: [] } })).toEqual({});
    expect(subject.apply({ type: 'message_end', message: { id: 'm1', content: [] } })).toEqual({});
  });

  it('ignores a tool call the agent reported without an identity', () => {
    expect(transcript().apply({ type: 'tool_execution_start', toolName: 'read' })).toEqual({});
    expect(transcript().apply({ type: 'tool_execution_start', toolCallId: 't1' })).toEqual({});
  });
});
