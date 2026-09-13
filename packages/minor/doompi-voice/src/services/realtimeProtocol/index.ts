// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Modified for DoomPi from codex-rs frameless bidi realtime protocol.

import { REALTIME_LIMITS, type RealtimeEvent } from '../../types/realtime';

const CONTEXT_APPEND_MAX_BYTES = 500;
const encoder = new TextEncoder();

export type RealtimeContextAppendChannel = 'speakable' | 'commentary';

interface JsonRecord {
  [key: string]: unknown;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= REALTIME_LIMITS.textCharacters ? value : undefined;
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= REALTIME_LIMITS.identifierCharacters
    ? value
    : undefined;
}

function transcriptEvent(parsed: JsonRecord, role: 'user' | 'assistant'): RealtimeEvent | undefined {
  const item = record(parsed.item);
  const text = boundedText(item?.text);
  return text === undefined ? undefined : { type: 'transcript', role, text, complete: false };
}

function completedTranscriptEvent(parsed: JsonRecord): RealtimeEvent | undefined {
  const turn = record(parsed.turn);
  const role = turn?.role;
  const text = boundedText(turn?.transcript);
  if ((role !== 'user' && role !== 'assistant') || text === undefined) return undefined;
  return { type: 'transcript', role, text, complete: true };
}

function delegationEvent(parsed: JsonRecord): RealtimeEvent | undefined {
  const item = record(parsed.item);
  if (item?.type !== 'delegation' || item.target !== 'client') return undefined;
  const requestId = boundedIdentifier(item.id);
  if (!requestId || !Array.isArray(item.content)) return undefined;

  let text = '';
  for (const entry of item.content) {
    const content = record(entry);
    if (content?.type !== 'input_text') continue;
    const part = boundedText(content.text);
    if (part === undefined || text.length + part.length > REALTIME_LIMITS.textCharacters) return undefined;
    text += part;
  }
  return { type: 'request', requestId, text };
}

function errorEvent(parsed: JsonRecord): RealtimeEvent {
  const nestedError = record(parsed.error);
  const candidate = boundedIdentifier(parsed.code) ?? boundedIdentifier(nestedError?.code);
  const code = candidate && /^[A-Za-z0-9_.-]+$/u.test(candidate) ? candidate : 'realtime_error';
  return { type: 'error', code };
}

/** Parses only source-backed V3 events represented by DoomPi's bounded public event union. */
export function parseRealtimeEvent(raw: string): RealtimeEvent | undefined {
  if (encoder.encode(raw).byteLength > REALTIME_LIMITS.eventBytes) return undefined;

  let parsed: JsonRecord | undefined;
  try {
    parsed = record(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed.type !== 'string') return undefined;

  switch (parsed.type) {
    case 'session.started':
    case 'session.updated': {
      const session = record(parsed.session);
      return boundedIdentifier(session?.id) ? { type: 'ready' } : undefined;
    }
    case 'input_transcript.added':
      return transcriptEvent(parsed, 'user');
    case 'output_transcript.added':
      return transcriptEvent(parsed, 'assistant');
    case 'turn.done':
      return completedTranscriptEvent(parsed);
    case 'delegation.created':
      return delegationEvent(parsed);
    case 'error':
      return errorEvent(parsed);
    default:
      return undefined;
  }
}

function assertContextInput(identifier: string | undefined, text: string): void {
  if ((identifier !== undefined && !boundedIdentifier(identifier)) || text.length > REALTIME_LIMITS.textCharacters) {
    throw new Error('Realtime context append input exceeds the configured limit.');
  }
}

function contextChunks(text: string): string[] {
  if (encoder.encode(text).byteLength <= CONTEXT_APPEND_MAX_BYTES) return [text];

  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (chunkBytes + characterBytes > CONTEXT_APPEND_MAX_BYTES) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk || text.length === 0) chunks.push(chunk);
  return chunks;
}

function serializeContextMessage(message: JsonRecord): string {
  const serialized = JSON.stringify(message);
  if (encoder.encode(serialized).byteLength > REALTIME_LIMITS.eventBytes) {
    throw new Error('Realtime control message exceeds the configured limit.');
  }
  return serialized;
}

/** Serializes correlated client delegation results for the browser data channel. */
export function buildDelegationResultMessages(
  requestId: string,
  text: string,
  channel?: RealtimeContextAppendChannel,
): string[] {
  assertContextInput(requestId, text);
  return contextChunks(text).map((chunk) =>
    serializeContextMessage({
      type: 'delegation.context.append',
      delegation_item_id: requestId,
      ...(channel ? { channel } : {}),
      content: [{ type: 'input_text', text: chunk }],
    }),
  );
}

/** Serializes session context for the browser data channel. */
export function buildSessionContextMessages(text: string, channel?: RealtimeContextAppendChannel): string[] {
  assertContextInput(undefined, text);
  return contextChunks(text).map((chunk) =>
    serializeContextMessage({
      type: 'session.context.append',
      ...(channel ? { channel } : {}),
      content: [{ type: 'input_text', text: chunk }],
    }),
  );
}
