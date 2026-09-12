import { describe, expect, it } from 'vitest';
import { createAcpSessionUpdateProjection } from '../../../../src/services/acpSessionUpdates';
import { createRpcTranscript } from '../../../../src/services/rpcTranscript';
import type { SessionFrame } from '../../../../src/types/server/session';

describe('ACP-shaped session updates', () => {
  it('reports one accepted user message, running work, and an idle stop reason', () => {
    const transcript = createRpcTranscript({ id: 'session-1', cwd: '/workspace', now: () => 10, retainEntries: 0 });
    const projection = createAcpSessionUpdateProjection();
    const apply = (frame: SessionFrame) => projection.apply(frame, transcript.apply(frame));
    expect(apply({ type: 'agent_start' })).toEqual([{ sessionUpdate: 'state_update', state: 'running' }]);
    const user = { role: 'user', content: 'hello', timestamp: 123 };
    expect(apply({ type: 'message_start', message: user })).toEqual([
      { sessionUpdate: 'user_message', messageId: 'user-123', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(apply({ type: 'message_end', message: user })).toEqual([]);
    expect(apply({ type: 'agent_settled' })).toEqual([
      { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
    ]);
  });

  it('upserts streamed assistant content and tool status using stable IDs', () => {
    const transcript = createRpcTranscript({ id: 'session-1', cwd: '/workspace', now: () => 10, retainEntries: 0 });
    const projection = createAcpSessionUpdateProjection();
    const apply = (frame: SessionFrame) => projection.apply(frame, transcript.apply(frame));
    apply({ type: 'message_start', message: { id: 'assistant-1', role: 'assistant', content: [] } });
    expect(
      apply({
        type: 'message_update',
        message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      }),
    ).toContainEqual({
      sessionUpdate: 'agent_message',
      messageId: 'assistant-1',
      content: [{ type: 'text', text: 'partial' }],
    });
    expect(apply({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: {} })).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' }),
    );
    expect(apply({ type: 'tool_execution_end', toolCallId: 'call-1', result: { content: 'done' } })).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }),
    );
  });
});
