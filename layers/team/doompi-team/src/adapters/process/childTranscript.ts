/**
 * Append-only JSONL transcript of one child run, written by the parent.
 *
 * WHY THE PARENT WRITES ITS OWN:
 * The child's session transcript lives in the host agent's config directory and
 * is keyed by a session id the parent does not learn until the run ends. This
 * file is the parent's independent record: it exists from the first prompt, it
 * survives a child that never started, and it carries the stdout and stderr the
 * child's own transcript has no place for.
 *
 * DESIGN PATTERNS:
 * - Two independent byte budgets. Each tool payload is capped so one huge result
 *   cannot consume the file, and the file itself is capped so a runaway child
 *   cannot fill the disk
 * - The file budget reserves room for the truncation marker up front, so the
 *   record that trips the limit is dropped in favour of a record explaining why
 * - Write failures latch into one reported error instead of throwing. This file
 *   is evidence about a run, so losing it must never end the run it describes
 * - Truncation is carried as a flag beside the text. The predecessor rediscovered
 *   it by searching the output for the marker substring, which any payload
 *   quoting that phrase would have tripped
 *
 * PERFORMANCE:
 * The marker's byte size is measured once. Every field feeding it is fixed for
 * the writer's lifetime and both timestamps are fixed width, so the predecessor's
 * re-serialisation of the marker on every single record bought nothing.
 *
 * AVOID:
 * - Throwing from any writer method
 * - Cutting a payload mid-character; the cut walks back off UTF-8 continuation
 *   bytes before slicing
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CHILD_TRANSCRIPT_ARTIFACT_VERSION = 1;

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = 1024 * BYTES_PER_KIB;
const MAX_TOOL_PAYLOAD_BYTES = 32 * BYTES_PER_KIB;
const DEFAULT_MAX_CHILD_TRANSCRIPT_BYTES = 50 * BYTES_PER_MIB;
const TOOL_PAYLOAD_TRUNCATION_MARKER = '\n\n… payload truncated';
const JSON_INDENT = 2;

/** High bits identifying a UTF-8 continuation byte (10xxxxxx). */
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

const PREVIEW_ELLIPSIS = '...';
const PREVIEW_MAX_LENGTH = 60;
const FALLBACK_PREVIEW_MAX_LENGTH = 50;
const WORKFLOW_PREVIEW_MAX_LENGTH = 48;
const MCP_ARGS_PREVIEW_MAX_LENGTH = 40;
const LIVE_ACTIVITY_MAX_LENGTH = 72;

/** Argument keys worth previewing verbatim, in the order they are preferred. */
const PREVIEW_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'describe', 'search'] as const;

/**
 * Which execution path produced the records in a file.
 *
 * Only background runs exist, so this is single-valued today. It is still
 * written into every record because the file is read by tools that must be able
 * to tell what produced it without being told out of band, and because a second
 * variant is cheaper to add than to retrofit onto files already on disk.
 */
export type ChildTranscriptSource = 'async';

export type ChildTranscriptRecordType = 'message' | 'tool_start' | 'tool_end' | 'stdout' | 'stderr' | 'truncated';

/**
 * The message fields this transcript records.
 *
 * Declared structurally rather than imported from the host agent's message type:
 * the writer only reads these fields, and a shared leaf should not take on an
 * optional peer dependency to describe them.
 */
export interface ChildTranscriptMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: unknown;
  model?: string;
  errorMessage?: string;
  stopReason?: string;
  usage?: unknown;
}

export interface ChildTranscriptEvent {
  type?: string;
  message?: ChildTranscriptMessage;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}

export interface ChildTranscriptWriterInput {
  transcriptPath: string;
  source: ChildTranscriptSource;
  runId: string;
  agent: string;
  childIndex?: number;
  cwd: string;
  maxBytes?: number;
}

export interface ChildTranscriptWriter {
  path: string;
  writeInitialUserMessage(prompt: string): void;
  writeChildEvent(event: ChildTranscriptEvent): void;
  writeStdoutLine(line: string): void;
  writeStderrLine(line: string): void;
  writeStderrText(text: string): void;
  getError(): string | undefined;
}

interface BoundedPayload {
  text: string;
  truncated: boolean;
}

interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Render `value` as text no larger than `maxBytes`, or undefined if it carries
 * nothing worth recording.
 *
 * A value that cannot be serialised (a cycle, a BigInt) is dropped rather than
 * reported, because a tool payload is context and not part of the run's result.
 */
function boundedPayload(value: unknown, maxBytes = MAX_TOOL_PAYLOAD_BYTES): BoundedPayload | undefined {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      const serialized = JSON.stringify(value, null, JSON_INDENT);
      if (serialized === undefined) return undefined;
      text = serialized;
    } catch {
      // Cyclic or non-serialisable payloads have no textual form to record.
      return undefined;
    }
  }
  if (!text.trim()) return undefined;

  const payload = Buffer.from(text, 'utf-8');
  if (payload.length <= maxBytes) return { text, truncated: false };

  const markerBytes = Buffer.byteLength(TOOL_PAYLOAD_TRUNCATION_MARKER, 'utf-8');
  let end = Math.max(0, maxBytes - markerBytes);
  // Back off any continuation bytes so the cut lands on a character boundary.
  while (end > 0 && ((payload[end] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) end--;
  return {
    text: `${payload.subarray(0, end).toString('utf-8')}${TOOL_PAYLOAD_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

/**
 * Read a child's usage counters, tolerating both field namings the host has used.
 *
 * Cost arrives either as a number or as an object with a `total`, so both are
 * accepted; anything else counts as zero rather than as missing, because a run
 * with unreadable cost still has a real elapsed usage record.
 */
function normalizeUsage(value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const rawCost = raw.cost;
  const cost =
    rawCost && typeof rawCost === 'object'
      ? (finiteNumber((rawCost as { total?: unknown }).total) ?? 0)
      : (finiteNumber(rawCost) ?? 0);
  return {
    input: finiteNumber(raw.input) ?? finiteNumber(raw.inputTokens) ?? 0,
    output: finiteNumber(raw.output) ?? finiteNumber(raw.outputTokens) ?? 0,
    cacheRead: finiteNumber(raw.cacheRead) ?? 0,
    cacheWrite: finiteNumber(raw.cacheWrite) ?? 0,
    cost,
  };
}

/**
 * Return the token total observed on one finalized child message.
 *
 * Missing usage means that this message carried no observation and therefore
 * returns undefined. An actual usage object with empty or zero buckets returns
 * zero, which is a meaningful observation for live progress.
 */
export function getMessageUsageTokens(message: ChildTranscriptMessage): number | undefined {
  if (message.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') return undefined;
  const raw = message.usage as Record<string, unknown>;
  const totalTokens = finiteNumber(raw.totalTokens);
  if (totalTokens !== undefined) return totalTokens;

  const usage = normalizeUsage(message.usage);
  if (!usage) return undefined;
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * A bounded tail of the assistant's current streamed text/thinking.
 *
 * The tail changes as the model streams, so a parent can show what the child is
 * doing between tool calls instead of leaving the last tool frozen on screen.
 */
export function getMessageActivity(message: ChildTranscriptMessage): string | undefined {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index];
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    const raw =
      record.type === 'thinking' && typeof record.thinking === 'string'
        ? record.thinking
        : typeof record.text === 'string'
          ? record.text
          : undefined;
    const activity = raw?.replace(/\s+/g, ' ').trim();
    if (!activity) continue;
    if (activity.length <= LIVE_ACTIVITY_MAX_LENGTH) return `working: ${activity}`;
    return `working: …${activity.slice(-(LIVE_ACTIVITY_MAX_LENGTH - 1))}`;
  }
  return undefined;
}

function truncatePreview(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - PREVIEW_ELLIPSIS.length)}${PREVIEW_ELLIPSIS}` : value;
}

function stringifyPreviewValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function previewArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = stringifyPreviewValue(value[0]);
  if (!first) return undefined;
  const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : '';
  return `${first}${suffix}`;
}

/**
 * One short line describing what a tool call was asked to do.
 *
 * The ladder is ordered by how much the key tells a reader, not alphabetically:
 * an MCP call is named by server and tool, a search by its query, and everything
 * else falls back to the first stringable argument so the line is never empty
 * when the call had any arguments at all.
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
  if (typeof args.tool === 'string' && args.tool) {
    const server = typeof args.server === 'string' && args.server ? `${args.server}/` : '';
    const toolArgs =
      typeof args.args === 'string' && args.args ? ` ${args.args.slice(0, MCP_ARGS_PREVIEW_MAX_LENGTH)}` : '';
    return `${server}${args.tool}${toolArgs}`;
  }

  const queriesPreview = previewArray(args.queries);
  if (queriesPreview) return truncatePreview(queriesPreview, PREVIEW_MAX_LENGTH);
  if (typeof args.query === 'string' && args.query.trim().length > 0) {
    return truncatePreview(args.query, PREVIEW_MAX_LENGTH);
  }
  if (typeof args.workflow === 'string' && args.workflow.trim().length > 0) {
    return `workflow=${truncatePreview(args.workflow, WORKFLOW_PREVIEW_MAX_LENGTH)}`;
  }
  if (typeof args.url === 'string' && args.url.trim().length > 0) return truncatePreview(args.url, PREVIEW_MAX_LENGTH);
  const urlsPreview = previewArray(args.urls);
  if (urlsPreview) return truncatePreview(urlsPreview, PREVIEW_MAX_LENGTH);
  if (typeof args.prompt === 'string' && args.prompt.trim().length > 0) {
    return truncatePreview(args.prompt, PREVIEW_MAX_LENGTH);
  }

  for (const key of PREVIEW_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return truncatePreview(value, PREVIEW_MAX_LENGTH);
  }

  for (const [key, value] of Object.entries(args)) {
    const arrayPreview = previewArray(value);
    if (arrayPreview) return `${key}=${truncatePreview(arrayPreview, FALLBACK_PREVIEW_MAX_LENGTH)}`;
    if (typeof value === 'string' && value.length > 0) {
      return `${key}=${truncatePreview(value, FALLBACK_PREVIEW_MAX_LENGTH)}`;
    }
  }
  return '';
}

/** A compact description of a live tool call for the parent task trail. */
export function formatToolActivity(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolName;
  const preview = extractToolArgsPreview(args as Record<string, unknown>);
  return preview ? `${toolName} (${preview})` : toolName;
}

/**
 * Flatten a message's content into plain text.
 *
 * Content arrives as unknown JSON in four shapes the host has used over time, so
 * every hop is checked. Anything unrecognised contributes nothing rather than
 * being stringified, which would put `[object Object]` into the transcript.
 */
function extractTextFromContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && 'text' in record) {
      texts.push(String(record.text));
    } else if (record.type === 'tool_result' && 'content' in record) {
      const inner = extractTextFromContent(record.content);
      if (inner) texts.push(inner);
    } else if ('text' in record) {
      texts.push(String(record.text));
    }
  }
  return texts.join('\n');
}

function eventArgs(event: ChildTranscriptEvent): Record<string, unknown> {
  return event.args && typeof event.args === 'object' && !Array.isArray(event.args)
    ? (event.args as Record<string, unknown>)
    : {};
}

export function createChildTranscriptWriter(input: ChildTranscriptWriterInput): ChildTranscriptWriter {
  let bytesWritten = 0;
  let writeError: string | undefined;
  let truncated = false;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_CHILD_TRANSCRIPT_BYTES;

  const baseRecord = (recordType: ChildTranscriptRecordType) => {
    const ts = Date.now();
    return {
      version: CHILD_TRANSCRIPT_ARTIFACT_VERSION,
      recordType,
      source: input.source,
      runId: input.runId,
      agent: input.agent,
      ...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
      cwd: input.cwd,
      ts,
      timestamp: new Date(ts).toISOString(),
    };
  };

  const truncationMarkerLine = (): string =>
    `${JSON.stringify({
      ...baseRecord('truncated'),
      maxBytes,
      message: `Child transcript exceeded ${maxBytes} bytes; further records were omitted.`,
    })}\n`;

  // Fixed for this writer: every field is constant except the two timestamps,
  // which are fixed width. Measuring once is why writeRecord stays allocation-free.
  const reservedMarkerBytes = Buffer.byteLength(truncationMarkerLine(), 'utf-8');

  const writeTruncatedMarker = () => {
    truncated = true;
    const marker = truncationMarkerLine();
    const markerBytes = Buffer.byteLength(marker, 'utf-8');
    if (bytesWritten + markerBytes > maxBytes) return;
    try {
      fs.appendFileSync(input.transcriptPath, marker, 'utf-8');
      bytesWritten += markerBytes;
    } catch (error) {
      writeError = `Failed to write child transcript '${input.transcriptPath}': ${errorMessage(error)}`;
    }
  };

  const writeRecord = (record: Record<string, unknown>) => {
    if (writeError || truncated) return;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf-8');
    // The marker's room is reserved, so the file can always state why it ended.
    if (bytesWritten + bytes + reservedMarkerBytes > maxBytes) {
      writeTruncatedMarker();
      return;
    }
    try {
      fs.appendFileSync(input.transcriptPath, line, 'utf-8');
      bytesWritten += bytes;
    } catch (error) {
      writeError = `Failed to write child transcript '${input.transcriptPath}': ${errorMessage(error)}`;
    }
  };

  try {
    fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
    fs.writeFileSync(input.transcriptPath, '', 'utf-8');
  } catch (error) {
    writeError = `Failed to initialize child transcript '${input.transcriptPath}': ${errorMessage(error)}`;
  }

  const writeMessage = (sourceEventType: string, message: ChildTranscriptMessage) => {
    const text = extractTextFromContent(message.content);
    const usage = normalizeUsage(message.usage);
    if (message.role === 'toolResult') {
      const output = boundedPayload(text);
      writeRecord({
        ...baseRecord('message'),
        sourceEventType,
        role: message.role,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        ...(output ? { text: output.text, outputTruncated: output.truncated } : {}),
        message: {
          role: message.role,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          content: output ? [{ type: 'text', text: output.text }] : [],
          ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
        },
      });
      return;
    }
    writeRecord({
      ...baseRecord('message'),
      sourceEventType,
      role: message.role,
      ...(text ? { text } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      ...(usage ? { usage } : {}),
      message,
    });
  };

  const writeStderrLine = (line: string) => {
    if (!line.trim()) return;
    writeRecord({ ...baseRecord('stderr'), text: line });
  };

  return {
    path: input.transcriptPath,
    writeInitialUserMessage(prompt: string) {
      writeRecord({
        ...baseRecord('message'),
        sourceEventType: 'initial_prompt',
        role: 'user',
        text: prompt,
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      });
    },
    writeChildEvent(event: ChildTranscriptEvent) {
      if ((event.type === 'message_end' || event.type === 'tool_result_end') && event.message) {
        writeMessage(event.type, event.message);
        return;
      }
      if (event.type === 'tool_execution_start' && event.toolName) {
        const args = eventArgs(event);
        const argsPayload = boundedPayload(args);
        writeRecord({
          ...baseRecord('tool_start'),
          sourceEventType: event.type,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          toolName: event.toolName,
          ...(Object.keys(args).length > 0 ? { argsPreview: extractToolArgsPreview(args) } : {}),
          ...(argsPayload ? { argsPayload: argsPayload.text } : {}),
        });
        return;
      }
      if (event.type === 'tool_execution_end') {
        writeRecord({
          ...baseRecord('tool_end'),
          sourceEventType: event.type,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          ...(event.toolName ? { toolName: event.toolName } : {}),
          ...(typeof event.isError === 'boolean' ? { isError: event.isError } : {}),
        });
      }
    },
    writeStdoutLine(line: string) {
      if (!line.trim()) return;
      writeRecord({ ...baseRecord('stdout'), text: line });
    },
    writeStderrLine,
    writeStderrText(text: string) {
      for (const line of text.split(/\r?\n/)) writeStderrLine(line);
    },
    getError() {
      return writeError;
    },
  };
}
