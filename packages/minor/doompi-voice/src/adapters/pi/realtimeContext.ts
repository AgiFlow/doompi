import { REALTIME_LIMITS } from '../../types/realtime.ts';
import { collectVoiceCommandContext } from './voiceCommandContext.ts';

const MAX_BRANCH_ENTRIES = 256;
const MAX_CONVERSATION_ENTRIES = 24;
const MAX_CONTENT_BLOCKS = 32;
const MAX_CONVERSATION_TEXT_CHARACTERS = 1_024;
const CONTEXT_START = '<realtime-context provenance="pi-visible-branch" treatment="untrusted-data">';
const CONTEXT_END = '</realtime-context>';

interface VisibleConversationEntry {
  provenance: 'visible-user-message' | 'visible-assistant-message';
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visibleMessageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === 'string') {
    const text = message.content.slice(0, MAX_CONVERSATION_TEXT_CHARACTERS).trim();
    return text || undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  let text = '';
  for (const value of message.content.slice(0, MAX_CONTENT_BLOCKS)) {
    if (!isRecord(value) || value.type !== 'text' || typeof value.text !== 'string') continue;
    const remaining = MAX_CONVERSATION_TEXT_CHARACTERS - text.length;
    if (remaining <= 0) break;
    text += value.text.slice(0, remaining);
  }
  return text.trim() || undefined;
}

function visibleConversation(entries: readonly unknown[]): VisibleConversationEntry[] {
  const result: VisibleConversationEntry[] = [];
  for (let index = entries.length - 1; index >= 0 && result.length < MAX_CONVERSATION_ENTRIES; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue;
    const role = entry.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = visibleMessageText(entry.message);
    if (!text) continue;
    result.push({
      provenance: role === 'user' ? 'visible-user-message' : 'visible-assistant-message',
      text,
    });
  }
  return result.reverse();
}

function serializeContext(
  conversation: readonly VisibleConversationEntry[],
  pendingQuestions: readonly string[],
  progress: readonly string[],
  busy: boolean,
): string {
  const data = JSON.stringify({
    status: { provenance: 'pi-lifecycle-status', busy },
    conversation,
    progress: progress.map((text) => ({ provenance: 'task-status-subject', text })),
    pendingQuestions: pendingQuestions.map((text) => ({ provenance: 'ask-user-question', text })),
  });
  return `${CONTEXT_START}\n${data}\n${CONTEXT_END}`;
}

/**
 * Builds a bounded projection of user-visible Pi branch data for a realtime companion.
 * Only user and assistant text, task subjects, pending question text, and lifecycle busy
 * state are admitted. Thinking, tool output, arbitrary custom entries, and credential
 * objects are never traversed.
 */
export function buildRealtimeContext(entries: readonly unknown[], status: { busy: boolean }): string {
  const recentEntries = entries.slice(-MAX_BRANCH_ENTRIES);
  const commandContext = collectVoiceCommandContext(recentEntries);
  const pendingQuestions = commandContext?.pendingQuestions ?? [];
  const progress = commandContext?.tasks ?? [];
  const conversation = visibleConversation(recentEntries);

  let result = serializeContext(conversation, pendingQuestions, progress, status.busy);
  while (result.length > REALTIME_LIMITS.textCharacters && conversation.length > 0) {
    conversation.shift();
    result = serializeContext(conversation, pendingQuestions, progress, status.busy);
  }
  if (result.length > REALTIME_LIMITS.textCharacters) {
    throw new Error('Realtime context projection exceeds the configured limit.');
  }
  return result;
}
