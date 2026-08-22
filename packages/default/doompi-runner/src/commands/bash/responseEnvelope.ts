import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { estimateTokens } from '../../services/TokenEstimate/tokenEstimate';
import type { RunnerRecord } from '../../types/runnerRegistry';
import {
  getErrorBudgetRatio,
  getErrorMaxEntries,
  getErrorMaxVariantsJoined,
  getErrorPatterns,
  getHeadRatio,
  getResultMaxBytes,
  getResultMaxLines,
  getResultMaxTokens,
} from '../../types/config.ts';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
/** Variants retained per group while scanning; the rest only add to the count. */
const MAX_VARIANTS_TRACKED = 12;
/** Below this much shared text, joining reads worse than separate lines. */
const MIN_SHARED_AFFIX = 8;
/**
 * Severity anywhere in the opening of the line, not only at its start. Real
 * tooling buries it behind a tag or a timestamp: `[widget] build: error TS2322`.
 */
const ERROR_WINDOW_CHARS = 60;
const SEVERITY_TOKEN =
  /(?<![\w\-/=.])(?:errors?|fatal|panic|exception|traceback|assertion|assert|fail(?:ed|ure|ures)?)\b/iu;
/** `0 errors` and `no failures` are the success case wearing the same words. */
const NEGATED_SEVERITY = /\b(?:no|not|without|zero|0)\s+$/iu;

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  /** Tools this result makes available from here on in the transcript. */
  addedToolNames?: string[];
}

export function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text }], details };
}

export function errorResult(message: string): ToolResult {
  return textResult(`Error: ${message}`, { error: message });
}

/** Human-readable byte count, matching how pi reports output sizes. */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  /** Lines returned, which is what the model actually received. */
  outputLines: number;
}

export interface LogSummary {
  tail: string;
  bytes: number;
  lines: number;
  tailLines: number;
}

/** Accumulates grouped error lines while a log streams past, without holding it. */
class ErrorScan {
  private readonly byKey = new Map<string, { variants: string[]; count: number }>();

  constructor(private readonly maxEntries = getErrorMaxEntries()) {}

  push(line: string): void {
    if (!isErrorLine(line)) return;
    const trimmed = line.trim();
    const key = normalizeErrorLine(line);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.count += 1;
      // Only a line we have not seen verbatim earns a slot; identical repeats
      // are carried by the count alone.
      if (!existing.variants.includes(trimmed) && existing.variants.length < MAX_VARIANTS_TRACKED) {
        existing.variants.push(trimmed);
      }
      return;
    }
    if (this.byKey.size >= this.maxEntries) return;
    this.byKey.set(key, { variants: [trimmed], count: 1 });
  }

  entries(): SalvagedError[] {
    return [...this.byKey.values()];
  }
}

/** Reads a bounded head and tail plus exact metadata after the writer has flushed. */
export function summarizeLog(
  path: string,
  maxLines = getResultMaxLines(),
  maxBytes = getResultMaxBytes(),
  maxTokens = getResultMaxTokens(),
): LogSummary {
  let handle: number | undefined;
  try {
    const size = fs.statSync(path).size;
    handle = fs.openSync(path, 'r');
    const readBuffer = Buffer.alloc(FILE_READ_CHUNK_BYTES);
    // Both ends are captured at the full budget; the line trim decides the split.
    const endLimit = Math.max(1, maxBytes + 1);
    let headBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let tailBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let newlineCount = 0;
    let lastByte: number | undefined;
    const decoder = new StringDecoder('utf8');
    const scanned = new ErrorScan();
    let pending = '';
    for (;;) {
      const bytesRead = fs.readSync(handle, readBuffer, 0, readBuffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = readBuffer.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
      lastByte = chunk.at(-1);
      if (headBuffer.byteLength < endLimit) {
        headBuffer = Buffer.concat([headBuffer, chunk.subarray(0, endLimit - headBuffer.byteLength)]);
      }
      tailBuffer = appendBufferTail(tailBuffer, chunk, endLimit);
      pending += decoder.write(chunk);
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        scanned.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    if (pending.length > 0) scanned.push(pending);
    const lines = newlineCount + (size > 0 && lastByte !== 0x0a ? 1 : 0);
    // The tail capture holds the whole file only while the file fits inside one
    // buffer. Past that the start is already gone from it, so the two ends have
    // to be composed instead.
    const excerpt =
      size <= tailBuffer.byteLength
        ? boundExcerpt(utf8Tail(tailBuffer, tailBuffer.byteLength), maxLines, maxBytes, maxTokens)
        : composeExcerpt(
            headBuffer.toString('utf8'),
            utf8Tail(tailBuffer, tailBuffer.byteLength),
            lines,
            maxLines,
            maxBytes,
            scanned.entries(),
            maxTokens,
          );
    return { tail: excerpt.text, bytes: size, lines, tailLines: excerpt.lines };
  } catch {
    return { tail: '', bytes: 0, lines: 0, tailLines: 0 };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** Codex-style first-line pragma, for the one command that needs a wider result. */
const PRAGMA_PATTERN = /^\s*(?:#|\/\/)\s*@doom:\s*(\{.*\})\s*$/u;
const PRAGMA_BYTES_CEILING = 262_144;
const PRAGMA_LINES_CEILING = 5_000;
const PRAGMA_TOKENS_CEILING = 100_000;

export interface ResultBudget {
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxTokens?: number;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Reads `# @doom: {"maxResultBytes": 32768}` from the command's first line.
 *
 * The pragma is a shell comment, so it stays harmless if this parse is ever
 * skipped, and it survives verbatim into the log where a wider result can be
 * explained after the fact.
 */
export function parseResultPragma(command: string): ResultBudget {
  const match = PRAGMA_PATTERN.exec(command.split('\n', 1)[0] ?? '');
  if (!match?.[1]) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const source = parsed as Record<string, unknown>;
  const maxBytes = positiveInteger(source.maxResultBytes);
  const maxLines = positiveInteger(source.maxResultLines);
  const maxTokens = positiveInteger(source.maxResultTokens);
  return {
    ...(maxBytes === undefined ? {} : { maxBytes: Math.min(maxBytes, PRAGMA_BYTES_CEILING) }),
    ...(maxLines === undefined ? {} : { maxLines: Math.min(maxLines, PRAGMA_LINES_CEILING) }),
    ...(maxTokens === undefined ? {} : { maxTokens: Math.min(maxTokens, PRAGMA_TOKENS_CEILING) }),
  };
}

export interface SalvagedError {
  /** Distinct exact lines sharing one shape, in the order first seen. */
  readonly variants: readonly string[];
  /** Total occurrences across every variant. */
  readonly count: number;
}

function isErrorLine(line: string): boolean {
  const opening = line.slice(0, ERROR_WINDOW_CHARS);
  const match = SEVERITY_TOKEN.exec(opening);
  if (match && !NEGATED_SEVERITY.test(opening.slice(0, match.index))) return true;
  // Project patterns extend the built-in matcher; tooling this does not
  // recognise is exactly why they exist, so they are not negation-checked.
  return getErrorPatterns().some((pattern) => matchesCustomPattern(pattern, line));
}

const customPatterns = new Map<string, RegExp | undefined>();

function matchesCustomPattern(pattern: string, line: string): boolean {
  if (!customPatterns.has(pattern)) {
    try {
      customPatterns.set(pattern, new RegExp(pattern, 'iu'));
    } catch {
      customPatterns.set(pattern, undefined);
    }
  }
  return customPatterns.get(pattern)?.test(line) ?? false;
}

/** Masks the parts that differ between repeats of the same underlying failure. */
function normalizeErrorLine(line: string): string {
  return line
    .replace(/0x[0-9a-f]+/giu, '0x#')
    .replace(/\/[^\s:,)]+/gu, '/#')
    .replace(/\d+/gu, '#')
    .trim()
    .toLowerCase();
}

/**
 * Collapses repeats so one failure repeated two hundred times costs one slot.
 * Counting continues past the entry cap so the tallies stay honest.
 */
export function collectErrorLines(lines: Iterable<string>, maxEntries = getErrorMaxEntries()): SalvagedError[] {
  const scan = new ErrorScan(maxEntries);
  for (const line of lines) scan.push(line);
  return scan.entries();
}

function commonAffixLengths(values: readonly string[]): { prefix: number; suffix: number } {
  const shortest = values.reduce((min, value) => Math.min(min, value.length), Infinity);
  let prefix = 0;
  while (prefix < shortest && values.every((value) => value[prefix] === values[0]![prefix])) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    values.every((value) => value[value.length - 1 - suffix] === values[0]![values[0]!.length - 1 - suffix])
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

/** Back off to a whitespace boundary so the brackets hold whole tokens. */
function retreatToBoundary(value: string, length: number): number {
  const boundary = value.lastIndexOf(' ', Math.max(0, length - 1));
  return boundary >= 0 ? boundary + 1 : 0;
}

function advanceToBoundary(value: string, length: number): number {
  const cut = value.length - length;
  const boundary = value.indexOf(' ', cut);
  return boundary >= 0 ? value.length - boundary : 0;
}

/**
 * One line per distinct failure would be ideal, but repeats of one failure
 * across many files are the common case. Sharing the fixed text and joining
 * only the parts that differ keeps every file name without paying for the
 * message N times.
 */
function renderGroup(group: SalvagedError): string {
  const [first] = group.variants;
  if (first === undefined) return '';
  if (group.variants.length === 1) {
    return group.count > 1 ? `${first} (\u00d7${formatCount(group.count)})` : first;
  }

  const shown = group.variants.slice(0, getErrorMaxVariantsJoined());
  const { prefix, suffix } = commonAffixLengths(shown);
  const head = first.slice(0, retreatToBoundary(first, prefix));
  const tailLength = advanceToBoundary(first, suffix);
  const tail = tailLength > 0 ? first.slice(first.length - tailLength) : '';
  if (head.length + tail.length < MIN_SHARED_AFFIX) return shown.join('\n');

  const middles = shown.map((value) => value.slice(head.length, value.length - tail.length));
  const overflow = group.variants.length - shown.length;
  const joined = overflow > 0 ? `${middles.join('|')}|+${formatCount(overflow)}` : middles.join('|');
  return `${head}[${joined}]${tail}`;
}

function renderSalvaged(errors: readonly SalvagedError[], maxBytes: number): string[] {
  const rendered: string[] = [];
  let used = 0;
  for (const group of errors) {
    const text = renderGroup(group);
    if (text.length === 0) continue;
    const cost = Buffer.byteLength(text, 'utf8') + 1;
    if (used + cost > maxBytes) break;
    rendered.push(text);
    used += cost;
  }
  return rendered;
}

export interface Excerpt {
  /** Head, elision marker, and tail already composed for display. */
  readonly text: string;
  /** Lines actually shown, excluding the marker. */
  readonly lines: number;
  readonly truncated: boolean;
  readonly elidedLines: number;
}

interface Side {
  readonly text: string;
  readonly count: number;
}

function elisionMarker(elidedLines: number, salvagedCount = 0): string {
  const unit = elidedLines === 1 ? 'line' : 'lines';
  const errors = salvagedCount > 0 ? `, ${formatCount(salvagedCount)} shown below` : '';
  return `\u2026 [${formatCount(elidedLines)} ${unit} elided${errors}] \u2026`;
}

function splitTextLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

/** Whole lines only: a fragment of a line reads as data that was never there. */
function takeSide(
  lines: readonly string[],
  maxCount: number,
  maxBytes: number,
  fromEnd: boolean,
  maxTokens = Number.POSITIVE_INFINITY,
): Side {
  if (maxBytes <= 0 || maxCount <= 0) return { text: '', count: 0 };
  const ordered = fromEnd ? [...lines].reverse() : [...lines];
  const taken: string[] = [];
  let used = 0;
  let tokens = 0;
  for (const line of ordered) {
    if (taken.length >= maxCount) break;
    const cost = Buffer.byteLength(line, 'utf8') + (taken.length > 0 ? 1 : 0);
    // Dense output costs far more context than its byte count implies, so the
    // token ceiling stops the side even while bytes remain. The separator is
    // charged too: summing per-line estimates otherwise drifts past the ceiling
    // once the newlines between them are counted.
    const lineTokens = estimateTokens(line) + (taken.length > 0 ? 1 : 0);
    if (used + cost > maxBytes || tokens + lineTokens > maxTokens) break;
    taken.push(line);
    used += cost;
    tokens += lineTokens;
  }
  if (taken.length === 0) return { text: '', count: 0 };
  const restored = fromEnd ? taken.reverse() : taken;
  return { text: restored.join('\n'), count: restored.length };
}

/**
 * Used only when no whole line fits either side, which means the source has no
 * usable line boundary. A clamped fragment beats returning nothing at all.
 */
function clampedFragment(text: string, limitBytes: number): Side {
  const clamped = utf8Tail(Buffer.from(text, 'utf8'), limitBytes);
  const newline = clamped.indexOf('\n');
  const whole = newline >= 0 ? clamped.slice(newline + 1) : clamped;
  return { text: whole, count: whole.length > 0 ? 1 : 0 };
}

/** Charged against the budget so the composed excerpt still honours the ceiling. */
function markerReservation(totalLines: number): number {
  return Buffer.byteLength(elisionMarker(totalLines), 'utf8') + 2;
}

function assembleSides(
  head: Side,
  tail: Side,
  elidedLines: number,
  trailingNewline: boolean,
  limitBytes: number,
  salvaged: readonly string[] = [],
): Excerpt {
  const opening = elidedLines > 0 ? [elisionMarker(elidedLines, salvaged.length)] : [];
  const closing = elidedLines > 0 && salvaged.length > 0 ? ['\u2026'] : [];
  const parts = [head.text, ...opening, ...salvaged, ...closing, tail.text].filter((part) => part.length > 0);
  const body = parts.join('\n');
  const withNewline = trailingNewline && body.length > 0 ? `${body}\n` : body;
  const encoded = Buffer.from(withNewline, 'utf8');
  // Last resort: the ceiling is a hard promise to the caller.
  const text = encoded.byteLength > limitBytes ? utf8Tail(encoded, limitBytes) : withNewline;
  return { text, lines: head.count + tail.count, truncated: true, elidedLines: Math.max(0, elidedLines) };
}

function budgetFor(maxLines: number, maxBytes: number, totalLines: number, maxTokens: number) {
  const limitLines = Math.max(1, Math.floor(maxLines));
  const usable = Math.max(0, maxBytes - markerReservation(totalLines));
  // The marker is charged against both ceilings; counting it in bytes alone let
  // the composed excerpt drift past the token ceiling.
  const tokens = Math.max(1, Math.floor(maxTokens) - estimateTokens(elisionMarker(totalLines)));
  return {
    limitLines,
    headLines: Math.max(1, Math.floor(limitLines * getHeadRatio())),
    headBytes: Math.max(0, Math.floor(usable * getHeadRatio())),
    headTokens: Math.max(1, Math.floor(tokens * getHeadRatio())),
    usable,
    tokens,
  };
}

/**
 * Bounds text to the budget, keeping a leading excerpt as well as the tail.
 *
 * Failures announce themselves at both ends: a command that could not start
 * says so on line one, and a command that died says so on the last. Keeping
 * only the tail loses the first kind entirely.
 */
export function boundExcerpt(
  text: string,
  maxLines = getResultMaxLines(),
  maxBytes = getResultMaxBytes(),
  maxTokens = getResultMaxTokens(),
): Excerpt {
  if (text.length === 0) return { text: '', lines: 0, truncated: false, elidedLines: 0 };
  const { lines, trailingNewline } = splitTextLines(text);
  const totalBytes = Buffer.byteLength(text, 'utf8');
  const limitBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : totalBytes;
  const limitLines = Math.max(1, Math.floor(maxLines));
  if (lines.length <= limitLines && totalBytes <= limitBytes && estimateTokens(text) <= maxTokens) {
    return { text, lines: lines.length, truncated: false, elidedLines: 0 };
  }

  const budget = budgetFor(maxLines, limitBytes, lines.length, maxTokens);
  const head = takeSide(lines, budget.headLines, budget.headBytes, false, budget.headTokens);
  const rest = lines.slice(head.count);
  // Reserved only when the region beyond the head actually holds errors, so a
  // clean run still spends the whole remaining budget on its tail.
  const errorBytes = rest.some(isErrorLine) ? Math.floor(budget.usable * getErrorBudgetRatio()) : 0;
  const tailBytes = budget.usable - Buffer.byteLength(head.text, 'utf8') - errorBytes;
  const tailTokens = budget.tokens - estimateTokens(head.text);
  const tail = takeSide(rest, Math.max(1, budget.limitLines - head.count), tailBytes, true, tailTokens);
  if (head.count === 0 && tail.count === 0) {
    const fragment = clampedFragment(text, limitBytes);
    return { text: fragment.text, lines: fragment.count, truncated: true, elidedLines: lines.length - fragment.count };
  }
  const middle = lines.slice(head.count, lines.length - tail.count);
  const salvaged = errorBytes > 0 ? renderSalvaged(collectErrorLines(middle), errorBytes) : [];
  return assembleSides(head, tail, lines.length - head.count - tail.count, trailingNewline, limitBytes, salvaged);
}

/**
 * Same budget as `boundExcerpt`, for callers that streamed the two ends
 * separately and never held the middle. `totalLines` counts the whole source,
 * so the marker states what was dropped rather than what was captured.
 */
export function composeExcerpt(
  headSource: string,
  tailSource: string,
  totalLines: number,
  maxLines = getResultMaxLines(),
  maxBytes = getResultMaxBytes(),
  errors: readonly SalvagedError[] = [],
  maxTokens = getResultMaxTokens(),
): Excerpt {
  const limitBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : Number.MAX_SAFE_INTEGER;
  const budget = budgetFor(maxLines, limitBytes, totalLines, maxTokens);
  const headLines = splitTextLines(headSource).lines;
  const { lines: tailLines, trailingNewline } = splitTextLines(tailSource);
  // The line at each cut is a fragment of a line neither capture saw whole.
  const head = takeSide(
    headLines.slice(0, Math.max(0, headLines.length - 1)),
    budget.headLines,
    budget.headBytes,
    false,
    budget.headTokens,
  );
  const errorBytes = errors.length > 0 ? Math.floor(budget.usable * getErrorBudgetRatio()) : 0;
  const tailBytes = budget.usable - Buffer.byteLength(head.text, 'utf8') - errorBytes;
  const tailTokens = budget.tokens - estimateTokens(head.text);
  const tail = takeSide(tailLines.slice(1), Math.max(1, budget.limitLines - head.count), tailBytes, true, tailTokens);
  if (head.count === 0 && tail.count === 0) {
    const fragment = clampedFragment(tailSource, limitBytes);
    return {
      text: fragment.text,
      lines: fragment.count,
      truncated: true,
      elidedLines: Math.max(0, totalLines - fragment.count),
    };
  }
  const salvaged = errorBytes > 0 ? renderSalvaged(errors, errorBytes) : [];
  return assembleSides(
    head,
    tail,
    Math.max(0, totalLines - head.count - tail.count),
    trailingNewline,
    limitBytes,
    salvaged,
  );
}

/** Applies Doom's line and byte ceilings to text already held in memory. */
export function summarizeText(
  text: string,
  maxLines = getResultMaxLines(),
  maxBytes = getResultMaxBytes(),
): Pick<LogSummary, 'tail' | 'tailLines'> {
  const excerpt = boundExcerpt(text, maxLines, maxBytes);
  return { tail: excerpt.text, tailLines: excerpt.lines };
}

/** Bounds the complete model-facing result after status and recovery text are attached. */
export function boundResultText(text: string, maxBytes = getResultMaxBytes()): string {
  return boundExcerpt(text, getResultMaxLines(), maxBytes).text;
}

/**
 * Keeps both ends of an oversized result and points at the file holding the rest.
 *
 * The notice states the file's real size and line count so the model does not
 * guess at offsets when it goes on to read the file, which is the failure this
 * whole policy exists to prevent.
 */
export function truncateForResult(
  text: string,
  fullOutputPath: string,
  maxBytes = getResultMaxBytes(),
  maxLines = getResultMaxLines(),
): TruncatedOutput {
  const excerpt = boundExcerpt(text, maxLines, maxBytes);
  if (!excerpt.truncated) return { text, truncated: false, outputLines: excerpt.lines };

  return {
    text: `${excerpt.text}\n${truncationNotice(excerpt, fullOutputPath, text)}`,
    truncated: true,
    outputLines: excerpt.lines,
  };
}

function truncationNotice(excerpt: Excerpt, fullOutputPath: string, text: string): string {
  // Counted from the file, never from `text`. What the caller holds in memory
  // is itself capped, so using it here would understate the file by orders of
  // magnitude and send the reader looking past the end of a much longer file.
  const file = measureFile(fullOutputPath);
  const totalLines = file?.lines ?? countLines(text);
  const fileSize = file?.bytes ?? Buffer.byteLength(text, 'utf8');

  return [
    `[output truncated: showing ${formatCount(excerpt.lines)} of ${formatCount(totalLines)} lines,`,
    `${formatCount(excerpt.elidedLines)} elided from the middle.`,
    `Full output is at ${fullOutputPath} (${formatSize(fileSize)}, ${formatCount(totalLines)} lines).`,
    `Inspect it with doom-runner logs, or read the file with an offset near line ${formatCount(totalLines)}.]`,
  ].join(' ');
}

/** Real size and line count of the file the notice points at. */
function measureFile(path: string): { bytes: number; lines: number } | undefined {
  let handle: number | undefined;
  try {
    const bytes = fs.statSync(path).size;
    handle = fs.openSync(path, 'r');
    const buffer = Buffer.alloc(FILE_READ_CHUNK_BYTES);
    let newlineCount = 0;
    let lastByte: number | undefined;
    for (;;) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
      lastByte = chunk.at(-1);
    }
    return { bytes, lines: newlineCount + (bytes > 0 && lastByte !== 0x0a ? 1 : 0) };
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function utf8Tail(encoded: Buffer<ArrayBufferLike>, maxBytes: number): string {
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}
function appendBufferTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): Buffer<ArrayBufferLike> {
  if (chunk.byteLength >= limit) return Buffer.from(chunk.subarray(chunk.byteLength - limit));
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength > limit ? Buffer.from(combined.subarray(combined.byteLength - limit)) : combined;
}

/** `name  pid 1234  up 3m  sleep 60` — one runner per line. */
export function formatRunnerLine(record: RunnerRecord, now = Date.now()): string {
  const mode = record.interactive ? ' interactive' : '';
  return `${record.name}  pid ${record.pid}  up ${formatUptime(record.startedAt, now)}${mode}  ${record.command}`;
}

export function formatUptime(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
