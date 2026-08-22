import type { MinorModeRecord } from '@agimon-ai/doompi-extension-contracts/mode';
import { compactVoiceCommandContext, type VoiceCommandContext } from '../../services/commandCorrection.ts';

const ASK_USER_TOOL_NAME = 'ask_user_question';
const TASK_TOOL_NAME = 'task';
const MAX_BRANCH_ENTRIES = 256;
const MAX_CURRENT_TURN_MESSAGES = 128;
const MAX_MESSAGE_CONTENT_BLOCKS = 64;
const MAX_QUESTION_CONTEXT_ENTRIES = 4;
const MAX_QUESTION_OPTIONS = 8;
const MAX_TASK_CONTEXT_ENTRIES = 8;
const MAX_TASKS_SCANNED = 64;
const MAX_TOOL_CALL_ID_CHARACTERS = 128;
const MAX_QUESTION_CHARACTERS = 512;
const MAX_OPTION_LABEL_CHARACTERS = 128;
const MAX_TASK_SUBJECT_CHARACTERS = 512;
const MAX_MINOR_MODE_CONTEXT_ENTRIES = 16;
const MAX_MINOR_MODE_CONTEXT_CHARACTERS = 320;
const ACTIVE_TASK_STATUSES = new Set(['failed', 'in_progress', 'pending']);

interface MessageEntryLike {
  message: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageEntry(value: unknown): MessageEntryLike | undefined {
  if (!isRecord(value) || value.type !== 'message' || !isRecord(value.message)) return undefined;
  return { message: value.message };
}

function boundedTrim(value: string, maximum: number): string {
  return value.slice(0, maximum).trim();
}

function currentTurnMessages(entries: readonly unknown[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (let index = entries.length - 1; index >= 0 && messages.length < MAX_CURRENT_TURN_MESSAGES; index -= 1) {
    const entry = messageEntry(entries[index]);
    if (!entry) continue;
    if (entry.message.role === 'user') break;
    messages.push(entry.message);
  }
  return messages.reverse();
}

function pendingAskToolCallIds(messages: readonly Record<string, unknown>[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== ASK_USER_TOOL_NAME) continue;
    if (
      typeof message.toolCallId !== 'string' ||
      message.toolCallId.length > MAX_TOOL_CALL_ID_CHARACTERS ||
      !isRecord(message.details)
    )
      continue;
    if (message.details.awaitingResponse === true) ids.add(message.toolCallId);
    else ids.delete(message.toolCallId);
  }
  return ids;
}

function questionContext(argumentsValue: unknown): string[] {
  if (!isRecord(argumentsValue) || !Array.isArray(argumentsValue.questions)) return [];
  return argumentsValue.questions.slice(0, MAX_QUESTION_CONTEXT_ENTRIES).flatMap((value) => {
    if (!isRecord(value) || typeof value.question !== 'string') return [];
    const question = boundedTrim(value.question, MAX_QUESTION_CHARACTERS);
    if (!question) return [];
    const labels = Array.isArray(value.options)
      ? value.options.slice(0, MAX_QUESTION_OPTIONS).flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== 'string') return [];
          const label = boundedTrim(option.label, MAX_OPTION_LABEL_CHARACTERS);
          return label ? [label] : [];
        })
      : [];
    return [`${question}${labels.length > 0 ? ` ${labels.join(' | ')}` : ''}`];
  });
}

function pendingQuestions(entries: readonly unknown[]): string[] {
  const messages = currentTurnMessages(entries);
  const pendingIds = pendingAskToolCallIds(messages);
  if (pendingIds.size === 0) return [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const content = message.content.slice(-MAX_MESSAGE_CONTENT_BLOCKS);
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex];
      if (
        !isRecord(block) ||
        block.type !== 'toolCall' ||
        block.name !== ASK_USER_TOOL_NAME ||
        typeof block.id !== 'string' ||
        block.id.length > MAX_TOOL_CALL_ID_CHARACTERS ||
        !pendingIds.has(block.id)
      )
        continue;
      return questionContext(block.arguments);
    }
  }
  return [];
}

function taskPriority(status: string): number {
  if (status === 'in_progress') return 0;
  if (status === 'pending') return 1;
  return 2;
}

function taskContext(details: Record<string, unknown>): string[] {
  if (!Array.isArray(details.tasks)) return [];
  return details.tasks
    .slice(0, MAX_TASKS_SCANNED)
    .flatMap((value) => {
      if (
        !isRecord(value) ||
        typeof value.id !== 'number' ||
        !Number.isSafeInteger(value.id) ||
        typeof value.subject !== 'string' ||
        typeof value.status !== 'string' ||
        value.status.length > 32 ||
        !ACTIVE_TASK_STATUSES.has(value.status)
      )
        return [];
      return [
        {
          id: value.id,
          subject: boundedTrim(value.subject, MAX_TASK_SUBJECT_CHARACTERS),
          status: value.status,
        },
      ];
    })
    .filter((task) => task.subject.length > 0)
    .sort((left, right) => taskPriority(left.status) - taskPriority(right.status) || left.id - right.id)
    .slice(0, MAX_TASK_CONTEXT_ENTRIES)
    .map((task) => task.subject);
}

function latestTasks(entries: readonly unknown[]): string[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = messageEntry(entries[index]);
    if (!entry || entry.message.role !== 'toolResult' || entry.message.toolName !== TASK_TOOL_NAME) continue;
    if (isRecord(entry.message.details)) return taskContext(entry.message.details);
  }
  return [];
}

/**
 * Projects only compact, user-visible references from Pi's active branch.
 * Raw conversation text, tool output, task descriptions, and option descriptions
 * are deliberately excluded so correction context cannot become a second prompt.
 */
function minorModeContext(records: readonly MinorModeRecord[] | undefined): string[] {
  if (!records) return [];
  return records
    .slice(0, MAX_MINOR_MODE_CONTEXT_ENTRIES)
    .map(({ descriptor }) =>
      boundedTrim(
        `${descriptor.label} (${descriptor.id}) actions: ${descriptor.actions.map(({ id }) => id).join(', ') || 'none'}`,
        MAX_MINOR_MODE_CONTEXT_CHARACTERS,
      ),
    );
}

export function collectVoiceCommandContext(
  entries: readonly unknown[],
  minorModes?: readonly MinorModeRecord[],
): VoiceCommandContext | undefined {
  const recentEntries = entries.slice(-MAX_BRANCH_ENTRIES);
  return compactVoiceCommandContext({
    pendingQuestions: pendingQuestions(recentEntries),
    tasks: latestTasks(recentEntries),
    minorModes: minorModeContext(minorModes),
  });
}
