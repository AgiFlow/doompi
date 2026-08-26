import type {
  AssistantTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from '@earendil-works/pi-protocol';
import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';
import {
  summariseArgs,
  type AssistantEntry,
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
  return { kind: 'user', id: item.id, text };
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

/** Projects the protocol transcript onto the timeline the cockpit renders. */
export function toTimelineEntries(transcript: readonly TranscriptItem[]): TimelineEntry[] {
  return transcript.map((item) =>
    item.role === 'user' ? userEntry(item) : item.role === 'assistant' ? assistantEntry(item) : toolEntry(item),
  );
}
