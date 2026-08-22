/**
 * Reads and renders a run's child transcript for the fleet detail pane.
 *
 * NOT A PORT:
 * The predecessor's `fleetTranscript.ts` parsed the HOST agent's own session
 * JSONL. `childTranscript.ts` (`../shared/childTranscript.ts`) is a
 * from-scratch, write-only format this package invented for its own reasons
 * (see that module's header: it is the parent's independent record, not the
 * host's session file). Translating the predecessor's parser would build a
 * reader for a format nothing here writes, so this reads `childTranscript.ts`'s
 * actual record shapes (`message`/`tool_start`/`tool_end`/`stdout`/`stderr`/
 * `truncated`) directly.
 *
 * READ THE RECORD, NOT THE SUMMARY:
 * `childTranscript.ts` flattens each message to a `text` field with
 * `extractTextFromContent`, which recognises only `{type:'text'}`. An assistant
 * turn made of a `thinking` block plus `toolCall` blocks therefore flattens to
 * nothing, and the writer omits the field entirely - which is what produced
 * rows of bare `assistant` headers with no content under them. The writer does
 * still persist the whole `message.content` array verbatim, so this module
 * parses THAT: thinking becomes its own event, and a turn with no text emits no
 * assistant event at all. Same reasoning for `argsPayload` (full tool arguments,
 * written all along, previously unread) and for `role: 'toolResult'` records,
 * which used to be dropped so a reader could see what ran but never what came
 * back.
 *
 * INCREMENTAL BY CONSTRUCTION:
 * A transcript is append-only and can reach 50 MiB, while the fleet overlay
 * re-checks the selected run roughly once a second. Re-reading and re-parsing
 * the whole file on every change makes cost grow with run length, so the reader
 * is resumable (`readFleetTranscriptTail`): it reads only the bytes appended
 * since the last call, and the renderer keeps one rendered block per event so
 * an append re-renders only the new and mutated ones. Steady-state cost is
 * proportional to what arrived, not to what the file holds.
 *
 * DESIGN PATTERNS:
 * - Reading is tolerant, not strict: the writer appends lines as a run
 *   progresses, so the last line on disk may be a partial write mid-flush.
 *   A line that fails to parse is dropped rather than failing the whole read
 * - `tool_start`/`tool_end`/`toolResult` are folded into ONE `tool` event keyed
 *   by `toolCallId`, so the pane reads as a sequence of turns rather than three
 *   lines per call. Calls interleave and `tool_end` arrives BEFORE its
 *   `toolResult`, so the fold map retains an entry for as long as its event is
 *   retained rather than closing it out on `tool_end`
 * - A `tool_end` with no matching start (the start fell outside the retained
 *   window) still renders on its own rather than being dropped, since it is
 *   still evidence of what ran
 *
 * AVOID:
 * - Reusing a `FleetTranscriptTail` after passing it as `previous`. The reader
 *   takes ownership of its `events` and fold map instead of copying them, which
 *   is the whole point of resuming; the returned tail supersedes it
 */

import * as fs from 'node:fs';

import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { formatDuration, shortenPath } from './formatters';

export type FleetTranscriptEventKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'stdout' | 'stderr';

export interface FleetTranscriptEvent {
  kind: FleetTranscriptEventKind;
  at: number;
  text: string;
  /** Tool name, present only for `kind: 'tool'`. */
  name?: string;
  /** Present only for `kind: 'tool'`: `'running'` until a matching `tool_end` arrives. */
  status?: 'running' | 'ok' | 'error';
  /** Tool arguments parsed from `argsPayload`, when the writer recorded them. */
  args?: Record<string, unknown>;
  /** Tool output, folded in from the matching `toolResult` record. */
  result?: string;
  /** Set when the writer bounded `result` at its payload cap. */
  resultTruncated?: boolean;
  /** `tool_end` timestamp, for the call's duration. */
  endedAt?: number;
  /** Model that produced an assistant turn, when reported. */
  model?: string;
}

export interface FleetTranscript {
  events: FleetTranscriptEvent[];
  warning?: string;
}

/** One retained tool event and where it sits in `events`, so a later fold can mark it dirty. */
interface FleetTranscriptToolEntry {
  event: FleetTranscriptEvent;
  index: number;
}

/**
 * A resume point for `readFleetTranscriptTail`.
 *
 * `byteOffset` is deliberately the end of the last COMPLETE line rather than
 * the file size: a partial trailing line is left unconsumed so the next read
 * picks it up whole, instead of being dropped as unparseable the way a
 * whole-file read has to.
 */
export interface FleetTranscriptTail extends FleetTranscript {
  path: string;
  byteOffset: number;
  /** Size observed at this read. A later shrink means the file was replaced, forcing a full re-read. */
  size: number;
  toolCalls: Map<string, FleetTranscriptToolEntry>;
  /** Earliest index whose content changed in this read. Undefined when only appends happened. */
  firstDirtyIndex: number | undefined;
  /** Cumulative events dropped from the front by the retention cap. */
  droppedEvents: number;
}

/**
 * Retention cap. Bounds memory and worst-case render cost independently of how
 * long a run goes on; `droppedEvents` keeps the fact that a window was applied
 * visible, so a tail is never mistaken for a whole run.
 */
export const MAX_RETAINED_EVENTS = 1000;

const NEWLINE_BYTE = 0x0a;

interface RawRecord {
  recordType?: string;
  ts?: number;
  role?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  argsPreview?: string;
  argsPayload?: string;
  outputTruncated?: boolean;
  model?: string;
  message?: { role?: string; content?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLine(line: string): RawRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as RawRecord) : undefined;
  } catch {
    // The writer appends line-by-line; a trailing partial write on the last
    // line is expected while a run is in flight, not evidence of corruption.
    return undefined;
  }
}

/**
 * Split an assistant turn's raw content into its thinking and its prose.
 *
 * Returns undefined when the record carried no content array, so the caller can
 * fall back to the writer's flattened `text` rather than treating a shape this
 * does not recognise as an empty turn.
 */
function splitAssistantContent(content: unknown): { thinking: string[]; text: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking: string[] = [];
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type === 'thinking') {
      const value = typeof record.thinking === 'string' ? record.thinking : '';
      if (value.trim()) thinking.push(value);
      continue;
    }
    // Anything else - toolCall in particular - is represented by its own event,
    // so it must not be folded into the assistant turn's text.
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
  }
  return { thinking, text: texts.join('\n') };
}

function parseArgsPayload(payload: string | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // The writer bounds this payload, so a long argument set can land here
    // truncated mid-JSON. The preview still renders; the args just stay absent.
    return undefined;
  }
}

function emptyTail(transcriptPath: string, warning?: string): FleetTranscriptTail {
  return {
    path: transcriptPath,
    events: [],
    byteOffset: 0,
    size: 0,
    toolCalls: new Map(),
    firstDirtyIndex: undefined,
    droppedEvents: 0,
    ...(warning ? { warning } : {}),
  };
}

/** Read exactly the appended range, so cost tracks what arrived rather than what the file holds. */
function readRange(filePath: string, offset: number, length: number): Buffer {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const chunk = fs.readSync(handle, buffer, read, length - read, offset + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

function markDirty(tail: FleetTranscriptTail, index: number): void {
  if (tail.firstDirtyIndex === undefined || index < tail.firstDirtyIndex) tail.firstDirtyIndex = index;
}

function pushEvent(tail: FleetTranscriptTail, event: FleetTranscriptEvent): number {
  tail.events.push(event);
  return tail.events.length - 1;
}

/** Apply the retention cap, keeping every index that survives it consistent. */
function applyRetention(tail: FleetTranscriptTail): void {
  const excess = tail.events.length - MAX_RETAINED_EVENTS;
  if (excess <= 0) return;
  tail.events.splice(0, excess);
  tail.droppedEvents += excess;
  if (tail.firstDirtyIndex !== undefined) tail.firstDirtyIndex = Math.max(0, tail.firstDirtyIndex - excess);
  for (const [callId, entry] of tail.toolCalls) {
    const shifted = entry.index - excess;
    if (shifted < 0) tail.toolCalls.delete(callId);
    else entry.index = shifted;
  }
}

function consumeMessage(tail: FleetTranscriptTail, record: RawRecord): void {
  const at = record.ts ?? 0;
  if (record.role === 'toolResult') {
    const entry = record.toolCallId ? tail.toolCalls.get(record.toolCallId) : undefined;
    // A result whose call fell outside the retained window has nothing to
    // attach to; the call itself is already gone, so the output would be
    // unattributable rather than useful.
    if (!entry) return;
    entry.event.result = record.text ?? '';
    entry.event.resultTruncated = record.outputTruncated === true;
    if (record.isError === true) entry.event.status = 'error';
    markDirty(tail, entry.index);
    return;
  }
  if (record.role === 'user') {
    const text = record.text ?? '';
    if (text.trim()) pushEvent(tail, { kind: 'user', at, text });
    return;
  }
  if (record.role === 'assistant') {
    const parts = splitAssistantContent(record.message?.content);
    for (const thinking of parts?.thinking ?? []) pushEvent(tail, { kind: 'thinking', at, text: thinking });
    const text = parts ? parts.text : (record.text ?? '');
    // A turn that only thought and called tools has no prose of its own. Both
    // are already represented, so emitting a header for it says nothing.
    if (text.trim()) {
      pushEvent(tail, { kind: 'assistant', at, text, ...(record.model ? { model: record.model } : {}) });
    }
    return;
  }
  if (record.role === 'custom') {
    // Host-injected notices (skill suggestions, hook output) are part of what
    // the child was told, so they belong in the transcript rather than nowhere.
    const text = record.text ?? '';
    if (text.trim()) pushEvent(tail, { kind: 'notice', at, text });
  }
}

function consumeRecord(tail: FleetTranscriptTail, record: RawRecord): void {
  const at = record.ts ?? 0;
  if (record.recordType === 'message') return consumeMessage(tail, record);
  if (record.recordType === 'tool_start') {
    const args = parseArgsPayload(record.argsPayload);
    const event: FleetTranscriptEvent = {
      kind: 'tool',
      at,
      text: record.argsPreview ?? '',
      ...(record.toolName ? { name: record.toolName } : {}),
      status: 'running',
      ...(args ? { args } : {}),
    };
    const index = pushEvent(tail, event);
    if (record.toolCallId) tail.toolCalls.set(record.toolCallId, { event, index });
    return;
  }
  if (record.recordType === 'tool_end') {
    const entry = record.toolCallId ? tail.toolCalls.get(record.toolCallId) : undefined;
    if (entry) {
      // An error reported by either half of the call is the call's outcome.
      entry.event.status = record.isError === true || entry.event.status === 'error' ? 'error' : 'ok';
      entry.event.endedAt = at;
      markDirty(tail, entry.index);
      return;
    }
    pushEvent(tail, {
      kind: 'tool',
      at,
      text: '',
      ...(record.toolName ? { name: record.toolName } : {}),
      status: record.isError === true ? 'error' : 'ok',
    });
    return;
  }
  if (record.recordType === 'stdout' || record.recordType === 'stderr') {
    pushEvent(tail, { kind: record.recordType, at, text: record.text ?? '' });
  }
  // 'truncated' carries no displayable content of its own; the events
  // recorded before it already show what happened up to the cutoff.
}

/**
 * Read whatever has been appended since `previous`, or the whole file when no
 * resume point is given.
 *
 * Never throws: a missing or unreadable file is a normal state (the run has
 * not started writing yet, or was cleaned up), reported through `warning`
 * rather than an exception the caller would have to guard against.
 */
export function readFleetTranscriptTail(transcriptPath: string, previous?: FleetTranscriptTail): FleetTranscriptTail {
  let size: number;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (cause) {
    return emptyTail(transcriptPath, cause instanceof Error ? cause.message : String(cause));
  }

  // A shrink means the file was replaced rather than appended to, so nothing
  // parsed from the old one can be trusted to still describe it.
  const resumable =
    previous !== undefined &&
    previous.path === transcriptPath &&
    previous.warning === undefined &&
    size >= previous.byteOffset;

  const tail: FleetTranscriptTail = resumable
    ? { ...previous, size, firstDirtyIndex: undefined, warning: undefined }
    : emptyTail(transcriptPath);
  tail.size = size;
  if (size <= tail.byteOffset) return tail;

  let chunk: Buffer;
  try {
    chunk = readRange(transcriptPath, tail.byteOffset, size - tail.byteOffset);
  } catch (cause) {
    return { ...tail, warning: cause instanceof Error ? cause.message : String(cause) };
  }

  // Split at the last newline: 0x0A cannot occur inside a UTF-8 multi-byte
  // sequence, so this is a byte boundary that is also a character boundary.
  const lastNewline = chunk.lastIndexOf(NEWLINE_BYTE);
  const complete = lastNewline === -1 ? undefined : chunk.subarray(0, lastNewline + 1);
  const remainder = chunk.subarray(lastNewline + 1);

  // A trailing line with no newline after it is ambiguous: either a write
  // caught mid-flush, or simply the last record of a file the writer did not
  // terminate. Parsing decides - a half-written record cannot be valid JSON,
  // since it is missing its closing brace - so a complete record is never
  // withheld just because nothing followed it, and a partial one is left
  // unconsumed for the next read to pick up whole.
  const pending = remainder.length > 0 ? parseLine(remainder.toString('utf-8')) : undefined;
  tail.byteOffset += (complete?.length ?? 0) + (pending ? remainder.length : 0);
  if (!complete && !pending) return tail;

  for (const line of complete ? complete.toString('utf-8').split(/\r?\n/) : []) {
    const record = parseLine(line);
    if (record) consumeRecord(tail, record);
  }
  if (pending) consumeRecord(tail, pending);
  applyRetention(tail);
  return tail;
}

/** Whole-file read, for callers with no incremental state to keep. */
export function readFleetTranscript(transcriptPath: string): FleetTranscript {
  const tail = readFleetTranscriptTail(transcriptPath);
  return tail.warning ? { events: tail.events, warning: tail.warning } : { events: tail.events };
}

// ============================================================================
// Rendering
// ============================================================================

export type FleetTranscriptVerbosity = 'compact' | 'full';

export interface FleetTranscriptTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * What the renderer needs from a tail: the events, and the two facts that say
 * which rendered blocks are still valid. Deliberately narrower than
 * `FleetTranscriptTail` so rendering does not depend on the reader's file
 * bookkeeping.
 */
export type FleetTranscriptRenderable = Pick<FleetTranscriptTail, 'events' | 'firstDirtyIndex' | 'droppedEvents'>;

export interface FleetTranscriptRenderOptions {
  /** Run cwd, so absolute paths render as the part that actually differs between rows. */
  cwd?: string;
  verbosity: FleetTranscriptVerbosity;
}

/**
 * One rendered block per event, plus their flattened lines.
 *
 * Blocks are kept so an append re-renders only what changed: markdown is by far
 * the most expensive part of this module, and an assistant message's rendering
 * never changes once written.
 */
export interface FleetTranscriptRender {
  width: number;
  verbosity: FleetTranscriptVerbosity;
  cwd: string | undefined;
  droppedEvents: number;
  blocks: string[][];
  lines: string[];
}

const COMPACT_LINES: Record<'user' | 'thinking' | 'notice' | 'result', number> = {
  user: 8,
  thinking: 6,
  notice: 3,
  result: 3,
};
/** Even expanded, one 32 KiB tool result must not be able to bury the pane. */
const FULL_RESULT_LINES = 200;
const RESULT_GUTTER = '  ⎿ ';
const RESULT_CONTINUATION = '    ';

/** Keys that identify what a call actually did, ahead of the ones every call shares. */
const PRIMARY_ARG_KEYS = [
  'command',
  'pattern',
  'query',
  'queries',
  'prompt',
  'task',
  'describe',
  'workflow',
  'url',
  'urls',
  'old_string',
  'content',
  'file_path',
  'filePath',
  'path',
];
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath'];

function statusGlyph(status: FleetTranscriptEvent['status']): string {
  if (status === 'ok') return '✓';
  if (status === 'error') return '✗';
  return '…';
}

function statusColor(status: FleetTranscriptEvent['status']): string {
  if (status === 'error') return 'error';
  if (status === 'running') return 'accent';
  return 'success';
}

/**
 * Render a path as the part that distinguishes it.
 *
 * Every row in a single run shares the run's cwd as a prefix, so keeping it
 * costs the width that would otherwise show which file was touched.
 */
function displayPath(value: string, cwd?: string): string {
  if (cwd) {
    if (value === cwd) return '.';
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
    if (value.startsWith(prefix)) return value.slice(prefix.length) || '.';
  }
  return shortenPath(value);
}

function argToDisplay(value: unknown, cwd?: string): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const collapsed = trimmed.replace(/\s+/g, ' ');
    return collapsed.startsWith('/') ? displayPath(collapsed, cwd) : collapsed;
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => argToDisplay(entry, cwd)).filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return undefined;
}

/**
 * The call's headline arguments.
 *
 * Prefers the distinguishing argument over the shared one, then appends the
 * path when it was not already the headline - `grep` reads as
 * `pattern · where`, `read` as just the file.
 */
function toolArgsSummary(event: FleetTranscriptEvent, cwd?: string): string {
  const args = event.args;
  if (!args) return event.text ? displayPath(event.text, cwd) : '';
  let primaryKey: string | undefined;
  let primary: string | undefined;
  for (const key of PRIMARY_ARG_KEYS) {
    const display = argToDisplay(args[key], cwd);
    if (display) {
      primaryKey = key;
      primary = display;
      break;
    }
  }
  if (!primary) {
    for (const [key, value] of Object.entries(args)) {
      const display = argToDisplay(value, cwd);
      if (display) {
        primaryKey = key;
        primary = `${key}=${display}`;
        break;
      }
    }
  }
  if (!primary) return '';
  const pathKey = PATH_ARG_KEYS.find((key) => key !== primaryKey && typeof args[key] === 'string');
  const pathDisplay = pathKey ? argToDisplay(args[pathKey], cwd) : undefined;
  // A path that relativizes to the run's own cwd says nothing the pane does
  // not already know, and every such row would carry the same '.'.
  return pathDisplay && pathDisplay !== '.' ? `${primary} · ${pathDisplay}` : primary;
}

/** Wrap to `width`, capped, with the number of hidden lines stated rather than implied. */
function cappedLines(text: string, width: number, limit: number, decorate: (line: string) => string): string[] {
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width));
  if (wrapped.length <= limit) return wrapped.map(decorate);
  return [...wrapped.slice(0, limit).map(decorate), decorate(`… +${wrapped.length - limit} lines`)];
}

function renderToolEvent(
  event: FleetTranscriptEvent,
  width: number,
  theme: FleetTranscriptTheme,
  options: FleetTranscriptRenderOptions,
): string[] {
  const summary = toolArgsSummary(event, options.cwd);
  const duration = event.endedAt !== undefined ? formatDuration(Math.max(0, event.endedAt - event.at)) : undefined;
  const header = [
    theme.fg(statusColor(event.status), statusGlyph(event.status)),
    theme.bold(event.name ?? 'tool'),
    summary ? theme.fg('muted', summary) : undefined,
    duration ? theme.fg('dim', duration) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  const lines = [truncateToWidth(header, width)];

  if (options.verbosity === 'full' && event.args) {
    const pretty = JSON.stringify(event.args, null, 2);
    for (const line of pretty.split('\n')) {
      lines.push(theme.fg('dim', truncateToWidth(`${RESULT_CONTINUATION}${line}`, width)));
    }
  }

  const result = event.result?.trimEnd();
  if (result) {
    const limit = options.verbosity === 'full' ? FULL_RESULT_LINES : COMPACT_LINES.result;
    const color = event.status === 'error' ? 'error' : 'dim';
    const body = result.split('\n');
    const shown = body.slice(0, limit);
    shown.forEach((line, index) => {
      const prefix = index === 0 ? RESULT_GUTTER : RESULT_CONTINUATION;
      lines.push(theme.fg(color, truncateToWidth(`${prefix}${line}`, width)));
    });
    const hidden = body.length - shown.length;
    if (hidden > 0) lines.push(theme.fg('dim', truncateToWidth(`${RESULT_CONTINUATION}… +${hidden} lines`, width)));
    if (event.resultTruncated) {
      lines.push(theme.fg('dim', truncateToWidth(`${RESULT_CONTINUATION}(output truncated by the recorder)`, width)));
    }
  } else if (event.status === 'running') {
    lines.push(theme.fg('dim', truncateToWidth(`${RESULT_GUTTER}running…`, width)));
  }
  return lines;
}

function renderEvent(
  event: FleetTranscriptEvent,
  width: number,
  theme: FleetTranscriptTheme,
  markdownTheme: MarkdownTheme | undefined,
  options: FleetTranscriptRenderOptions,
): string[] {
  const safeWidth = Math.max(1, width);
  if (event.kind === 'tool') return [...renderToolEvent(event, safeWidth, theme, options), ''];

  if (event.kind === 'assistant') {
    const header = theme.fg('accent', theme.bold('● assistant'));
    // Markdown is the expensive call in this module; the block cache is what
    // keeps it to once per message rather than once per repaint.
    const body = markdownTheme
      ? new Markdown(event.text, 0, 0, markdownTheme).render(safeWidth)
      : wrapTextWithAnsi(event.text, safeWidth);
    return [header, ...body, ''];
  }

  if (event.kind === 'thinking') {
    const header = theme.fg('dim', theme.bold('✻ thinking'));
    const limit = options.verbosity === 'full' ? Number.POSITIVE_INFINITY : COMPACT_LINES.thinking;
    return [header, ...cappedLines(event.text, safeWidth, limit, (line) => theme.fg('dim', line)), ''];
  }

  if (event.kind === 'user') {
    const header = theme.fg('accent', theme.bold('▸ user'));
    const limit = options.verbosity === 'full' ? Number.POSITIVE_INFINITY : COMPACT_LINES.user;
    return [header, ...cappedLines(event.text, safeWidth, limit, (line) => line), ''];
  }

  if (event.kind === 'notice') {
    const limit = options.verbosity === 'full' ? Number.POSITIVE_INFINITY : COMPACT_LINES.notice;
    return [...cappedLines(`ℹ ${event.text}`, safeWidth, limit, (line) => theme.fg('muted', line)), ''];
  }

  const prefix = event.kind === 'stderr' ? theme.fg('warning', 'stderr') : theme.fg('dim', 'stdout');
  return [truncateToWidth(`${prefix} ${event.text}`, safeWidth), ''];
}

/**
 * Render `tail`'s events, reusing `previous`'s blocks wherever nothing changed.
 *
 * A full render happens only when something global changed - width, verbosity,
 * cwd, or the absence of a usable previous render. An append re-renders from
 * the earliest dirty index onward and reuses every block before it.
 */
export function renderFleetTranscript(
  tail: FleetTranscriptRenderable,
  width: number,
  theme: FleetTranscriptTheme,
  markdownTheme: MarkdownTheme | undefined,
  options: FleetTranscriptRenderOptions,
  previous?: FleetTranscriptRender,
): FleetTranscriptRender {
  const reusable =
    previous !== undefined &&
    previous.width === width &&
    previous.verbosity === options.verbosity &&
    previous.cwd === options.cwd &&
    previous.droppedEvents <= tail.droppedEvents;

  // Nothing changed at all: hand back the same render rather than rebuilding
  // a flat line array out of blocks that are all still valid. This is the
  // common case - every repaint driven by a keystroke or an unrelated run -
  // and without it the pane still pays a cost proportional to the whole
  // transcript on each one.
  if (
    reusable &&
    previous.droppedEvents === tail.droppedEvents &&
    tail.firstDirtyIndex === undefined &&
    previous.blocks.length === tail.events.length
  ) {
    return previous;
  }

  // Retention drops events off the front, so a reused block list has to be
  // realigned by however many went before it can be indexed alongside events.
  const base = reusable ? previous.blocks.slice(tail.droppedEvents - previous.droppedEvents) : [];
  const from = Math.min(tail.firstDirtyIndex ?? base.length, base.length, tail.events.length);
  const blocks = base.slice(0, from);
  for (let index = from; index < tail.events.length; index++) {
    blocks.push(renderEvent(tail.events[index], width, theme, markdownTheme, options));
  }

  const lines: string[] = [];
  if (tail.droppedEvents > 0) {
    lines.push(theme.fg('dim', truncateToWidth(`… ${tail.droppedEvents} earlier events not shown`, width)), '');
  }
  for (const block of blocks) lines.push(...block);
  return { width, verbosity: options.verbosity, cwd: options.cwd, droppedEvents: tail.droppedEvents, blocks, lines };
}
