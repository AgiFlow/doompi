import type {
  DoomContentBlock,
  DoomSessionStopReason,
  DoomSessionUpdate,
  TranscriptProgress,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import type { SessionFrame } from '../../types/server/session';
import type { TranscriptReduction } from '../rpcTranscript';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function content(value: unknown): DoomContentBlock[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return [];
  const blocks: DoomContentBlock[] = [];
  for (const part of value) {
    const item = record(part);
    if (item?.type === 'text' && typeof item.text === 'string') blocks.push({ type: 'text', text: item.text });
    if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string')
      blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType });
  }
  return blocks;
}

function progressUpdates(progress: TranscriptProgress): DoomSessionUpdate[] {
  const item = progress.item;
  if (item.role === 'user') return [{ sessionUpdate: 'user_message', messageId: item.id, content: item.content }];
  if (item.role === 'tool') {
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: item.toolCallId,
        title: item.toolName,
        kind: 'other',
        status: item.status === 'running' ? 'in_progress' : item.status === 'error' ? 'failed' : 'completed',
        rawInput: item.input,
        ...(progress.type === 'item_finished'
          ? { content: item.content.map((block) => ({ type: 'content' as const, content: block })) }
          : {}),
      },
    ];
  }
  const updates: DoomSessionUpdate[] = [];
  const messageContent = item.content.filter((part) => part.type === 'text');
  if (messageContent.length > 0)
    updates.push({ sessionUpdate: 'agent_message', messageId: item.id, content: messageContent });
  const thoughtContent = item.content.flatMap((part) =>
    part.type === 'thinking' && !part.redacted ? [{ type: 'text' as const, text: part.thinking }] : [],
  );
  if (thoughtContent.length > 0)
    updates.push({ sessionUpdate: 'agent_thought', messageId: `${item.id}:thought`, content: thoughtContent });
  for (const part of item.content) {
    if (part.type !== 'toolCall') continue;
    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: part.toolCallId,
      title: part.toolName,
      kind: 'other',
      status: 'pending',
      rawInput: part.input,
    });
  }
  return updates;
}

/** Projects the Pi frame stream into the ACP v2 session/update vocabulary. */
export function createAcpSessionUpdateProjection(): {
  apply(frame: SessionFrame, reduction: TranscriptReduction): DoomSessionUpdate[];
} {
  const seenUserMessages = new Set<string>();
  let lastStopReason: DoomSessionStopReason = 'end_turn';
  return {
    apply(frame, reduction) {
      const updates: DoomSessionUpdate[] = [];
      if (frame.type === 'message_start' || frame.type === 'message_end' || frame.type === 'entry_appended') {
        const entry = record(frame.entry);
        const message = record(frame.type === 'entry_appended' ? entry?.message : frame.message);
        if (message?.role === 'user') {
          const blocks = content(message.content);
          const id =
            typeof message.timestamp === 'number'
              ? `user-${message.timestamp}`
              : typeof entry?.id === 'string'
                ? entry.id
                : undefined;
          if (id !== undefined && blocks.length > 0 && !seenUserMessages.has(id)) {
            seenUserMessages.add(id);
            updates.push({ sessionUpdate: 'user_message', messageId: id, content: blocks });
          }
        }
      }
      if (reduction.progress) {
        updates.push(...progressUpdates(reduction.progress));
        if (reduction.progress.type === 'item_finished' && reduction.progress.item.role === 'assistant') {
          const reason = reduction.progress.item.stopReason;
          lastStopReason = reason === 'aborted' ? 'cancelled' : reason === 'length' ? 'max_tokens' : 'end_turn';
        }
      }
      if (frame.type === 'agent_start') updates.push({ sessionUpdate: 'state_update', state: 'running' });
      if (frame.type === 'extension_ui_request')
        updates.push({ sessionUpdate: 'state_update', state: 'requires_action' });
      if (frame.type === 'extension_ui_answered') updates.push({ sessionUpdate: 'state_update', state: 'running' });
      if (frame.type === 'agent_settled') {
        updates.push({ sessionUpdate: 'state_update', state: 'idle', stopReason: lastStopReason });
        lastStopReason = 'end_turn';
      }
      return updates;
    },
  };
}
