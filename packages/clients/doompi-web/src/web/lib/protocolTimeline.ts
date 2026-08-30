import type {
  AssistantTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from '@earendil-works/pi-protocol';
import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';
import {
  imagesFromContent,
  summariseArgs,
  type AssistantEntry,
  type QueuedEntry,
  type TimelineEntry,
  type ToolEntry,
  type UserEntry,
} from './sessionModel.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userEntry(item: UserTranscriptItem): UserEntry {
  const text = item.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const images = imagesFromContent(item.content);
  return { kind: 'user', id: item.id, text, ...(images.length > 0 ? { images } : {}) };
}

function assistantEntry(item: AssistantTranscriptItem): AssistantEntry {
  let text = '';
  let thinking = '';
  for (const part of item.content) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'thinking') thinking += part.thinking;
  }
  return { kind: 'assistant', id: item.id, text, thinking, streaming: item.status === 'streaming' };
}

/**
 * Rebuilds the tool card's view from the protocol item.
 *
 * `details` is the one field the protocol leaves open on a tool item, which is
 * where a DoomPi tool's own payload travels; handing it back whole is what
 * lets the owning plugin render its call the way it does in the terminal.
 */
function toolEntry(item: ToolTranscriptItem): ToolEntry {
  const output = item.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const result: ToolResultView | null =
    item.content.length > 0 || item.details !== undefined
      ? { content: [...item.content], details: item.details }
      : null;
  return {
    kind: 'tool',
    id: item.id,
    toolCallId: item.toolCallId,
    name: item.toolName,
    args: isRecord(item.input) ? item.input : {},
    argSummary: summariseArgs(item.input),
    result,
    output,
    isError: item.isError,
    running: item.status === 'running',
  };
}

const projectedEntries = new WeakMap<TranscriptItem, TimelineEntry>();

/** Projects one immutable protocol item once, so updates do not rebuild settled history. */
function timelineEntry(item: TranscriptItem): TimelineEntry {
  const cached = projectedEntries.get(item);
  if (cached !== undefined) return cached;
  const projected =
    item.role === 'user' ? userEntry(item) : item.role === 'assistant' ? assistantEntry(item) : toolEntry(item);
  projectedEntries.set(item, projected);
  return projected;
}

/** Projects the protocol transcript onto the timeline the cockpit renders. */
export function toTimelineEntries(transcript: readonly TranscriptItem[]): TimelineEntry[] {
  return transcript.map(timelineEntry);
}

/** Projects the protocol's authoritative pending input queue onto composer rows. */
export function toQueuedEntries(queue: readonly UserTranscriptItem[]): QueuedEntry[] {
  return queue.map((item) => ({ ...userEntry(item), kind: 'queued' }));
}
