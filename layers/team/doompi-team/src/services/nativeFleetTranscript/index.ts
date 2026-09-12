import type { TranscriptItem, TranscriptPage } from '@agimon-ai/doompi-core/session-protocol';
import type { FleetTranscriptEvent, FleetTranscriptTail } from '../fleetTranscript';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      const item = asRecord(part);
      return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n');
}

function transcriptItem(value: unknown): TranscriptItem | undefined {
  const entry = asRecord(value);
  const message = asRecord(entry?.message);
  const candidate = message ?? entry;
  return candidate && typeof candidate.role === 'string' ? (candidate as unknown as TranscriptItem) : undefined;
}

export function nativeTranscriptTail(runId: string, page: TranscriptPage): FleetTranscriptTail {
  const events: FleetTranscriptEvent[] = [];
  const calls = new Map<string, FleetTranscriptEvent>();
  const items = [...page.entries, ...page.drafts]
    .map(transcriptItem)
    .filter((item): item is TranscriptItem => Boolean(item));
  for (const item of items) {
    if (item.role === 'user') {
      const text = textParts(item.content);
      if (text.trim()) events.push({ kind: 'user', at: item.timestamp, text });
      continue;
    }
    if (item.role === 'assistant') {
      for (const part of item.content) {
        if (part.type === 'thinking' && part.thinking.trim())
          events.push({ kind: 'thinking', at: item.timestamp, text: part.thinking });
        else if (part.type === 'text' && part.text.trim())
          events.push({
            kind: 'assistant',
            at: item.timestamp,
            text: part.text,
            model: `${item.model.provider}/${item.model.id}`,
          });
        else if (part.type === 'toolCall') {
          const event: FleetTranscriptEvent = {
            kind: 'tool',
            at: item.timestamp,
            text: '',
            name: part.toolName,
            status: 'running',
            args: asRecord(part.input),
          };
          events.push(event);
          calls.set(part.toolCallId, event);
        }
      }
      continue;
    }
    const result = textParts(item.content);
    const call = calls.get(item.toolCallId);
    if (call) {
      call.status = item.isError || item.status === 'error' ? 'error' : item.status === 'running' ? 'running' : 'ok';
      call.result = result;
      if (item.status !== 'running') call.endedAt = item.timestamp;
    } else {
      events.push({
        kind: 'tool',
        at: item.timestamp,
        text: '',
        name: item.toolName,
        status: item.isError ? 'error' : item.status === 'running' ? 'running' : 'ok',
        args: asRecord(item.input),
        result,
      });
    }
  }
  return {
    path: `native:${runId}`,
    byteOffset: 0,
    size: events.length,
    events,
    toolCalls: new Map(),
    firstDirtyIndex: 0,
    droppedEvents: page.olderCursor ? 1 : 0,
  };
}
