import { stripAnsi } from './AnsiScrub/ansiScrub';
import { estimateTokens } from './TokenEstimate/tokenEstimate';
import type { BashRunResult, CompletedRun } from '../types/bashRunService';
import type { RunnerRecord } from '../types/runnerRegistry';
import {
  getErrorBudgetRatio,
  getErrorMaxEntries,
  getErrorMaxVariantsJoined,
  getErrorPatterns,
  getHeadRatio,
  getResultMaxBytes,
  getResultMaxLines,
  getResultMaxTokens,
  getSuccessResultMaxBytes,
  getSuccessResultMaxTokens,
} from '../types/config.ts';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
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

export interface ErrorLineScanner {
  push(line: string): void;
  entries(): SalvagedError[];
}

export function createErrorScanner(maxEntries = getErrorMaxEntries()): ErrorLineScanner {
  return new ErrorScan(maxEntries);
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

function utf8Tail(encoded: Buffer<ArrayBufferLike>, maxBytes: number): string {
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

/** `name  pid 1234  up 3m  sleep 60` — one runner per line. */
export function formatRunnerLine(record: RunnerRecord, now: number): string {
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

const PROMOTION_REASONS: Record<'requested' | 'threshold' | 'interactive', string> = {
  requested: 'Started in the background',
  threshold: 'Still running after the background threshold',
  interactive: 'Started interactively',
};

function completionFailed(result: CompletedRun): boolean {
  return result.timedOut === true || result.signal !== null || (result.exitCode !== null && result.exitCode !== 0);
}

function completionStatus(result: CompletedRun): string | undefined {
  if (result.timedOut === true) return 'Timed out: exceeded the requested timeout.';
  if (result.signal !== null) return `Signal: ${result.signal}`;
  if (result.exitCode === null) return 'Exit status unavailable.';
  if (result.exitCode !== 0) return `Exit: ${result.exitCode}`;
  return undefined;
}

export type LogSummarizer = (path: string, maxLines: number, maxBytes: number, maxTokens: number) => LogSummary;

const emptyLogSummary: LogSummarizer = () => ({ tail: '', bytes: 0, lines: 0, tailLines: 0 });

export function formatRunResult(
  result: BashRunResult,
  budget: ResultBudget = {},
  summarizeLog: LogSummarizer = emptyLogSummary,
): ToolResult {
  if (result.kind === 'failed') {
    throw new Error(
      [
        `Could not start runner "${result.name}": ${result.error}`,
        'Next: correct the reported launch or supervision problem. Retry only after changing the command or environment.',
      ].join('\n'),
    );
  }

  if (result.kind === 'promoted') {
    const reason = PROMOTION_REASONS[result.reason];
    const body = [
      `${reason}: runner "${result.name}" (${result.id}).`,
      `Streaming log: ${result.logPath}`,
      `Inspect: doom-runner logs ${result.id}`,
    ].join('\n');
    return textResult(body, {
      id: result.id,
      runner: result.name,
      pid: result.pid,
      logPath: result.logPath,
      promoted: true,
      reason: result.reason,
    });
  }

  const succeeded = !completionFailed(result);
  const maxLines = budget.maxLines ?? getResultMaxLines();
  const maxBytes = budget.maxBytes ?? (succeeded ? getSuccessResultMaxBytes() : getResultMaxBytes());
  const maxTokens = budget.maxTokens ?? (succeeded ? getSuccessResultMaxTokens() : getResultMaxTokens());
  const log = summarizeLog(result.logPath, maxLines, maxBytes, maxTokens);
  const useCapturedOutput = !result.rtkOutput && log.tail.length === 0 && result.output.length > 0;
  let tail: string;
  let tailLines: number;
  let outputLines: number;
  let outputBytes: number;
  let truncated: boolean;
  if (result.rtkOutput) {
    const clipped = Buffer.byteLength(result.rtkOutput.output, 'utf8') < result.rtkOutput.bytes;
    const bounded = clipped
      ? composeExcerpt(
          result.rtkOutput.head,
          result.rtkOutput.output,
          result.rtkOutput.lines,
          maxLines,
          maxBytes,
          [],
          maxTokens,
        )
      : boundExcerpt(result.rtkOutput.output, maxLines, maxBytes, maxTokens);
    tail = bounded.text;
    tailLines = bounded.lines;
    outputLines = result.rtkOutput.lines;
    outputBytes = result.rtkOutput.bytes;
    truncated = outputLines > tailLines || outputBytes > Buffer.byteLength(tail, 'utf8');
  } else {
    tail = useCapturedOutput ? result.output : log.tail;
    tailLines = useCapturedOutput ? countLines(tail) : log.tailLines;
    outputLines = Math.max(log.lines, tailLines);
    outputBytes = useCapturedOutput ? Buffer.byteLength(tail, 'utf8') : log.bytes;
    truncated = !useCapturedOutput && (outputLines > tailLines || outputBytes > Buffer.byteLength(tail, 'utf8'));
  }
  const plainTail = stripAnsi(tail).replace(/\r?\n$/u, '');
  const failed = completionFailed(result);
  const status = completionStatus(result);
  const textLines: string[] = [];
  if (plainTail.length === 0) {
    textLines.push(status === undefined ? 'Completed with no output.' : 'No output.');
  } else if (truncated) {
    const label = result.rtkOutput ? `RTK ${result.rtkOutput.filter} excerpt` : 'Log excerpt';
    textLines.push(
      `${label} (${tailLines.toLocaleString('en-US')} of ${outputLines.toLocaleString('en-US')} lines):\n${plainTail}`,
    );
  } else {
    textLines.push(plainTail);
  }
  if (status !== undefined) textLines.push(status);
  if (result.rtkWarning) textLines.push(result.rtkWarning);
  if (truncated) {
    const label = result.rtkOutput ? 'Complete raw log' : 'Full log';
    textLines.push(
      `${label}: ${result.logPath} (${formatSize(log.bytes)}, ${log.lines.toLocaleString('en-US')} lines); inspect with doom-runner logs ${result.id}`,
    );
  } else if (failed && plainTail.length === 0) {
    textLines.push(
      `Log: ${result.logPath}`,
      'Next: run one read-only diagnostic; retry only after correcting the cause.',
    );
  }
  const text = boundResultText(textLines.join('\n'), maxBytes);
  const details = {
    id: result.id,
    runner: result.name,
    exitCode: result.exitCode,
    logPath: result.logPath,
    backend: result.backend,
    fileSize: log.bytes,
    lines: useCapturedOutput ? tailLines : log.lines,
    tail,
    tailLines,
    ...(result.rtkOutput
      ? {
          rtkFilter: result.rtkOutput.filter,
          rtkOutputBytes: result.rtkOutput.bytes,
          rtkOutputLines: result.rtkOutput.lines,
        }
      : {}),
    ...(result.rtkWarning ? { rtkWarning: result.rtkWarning } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
  if (failed) throw new Error(text);
  return textResult(text, details);
}
