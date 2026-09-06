/**
 * Pure view logic for the bash tool card, the browser counterpart of
 * src/tui/bashRender.ts. The plugin may reach only its own files and
 * src/types, so the few TUI helpers it mirrors are copied here rather than
 * imported, and every input is the wire JSON of a tool_execution frame.
 */

const ELLIPSIS = '…';
/** Spaced so the join never glues two words into one unreadable token. */
const GAP = ' … ';
/** Wide enough to keep a realistic command intact, short enough to stay on a few rows. */
const MAX_COMMAND_LENGTH = 160;
/** Lines of log kept in the collapsed result, before the card is expanded. */
const COLLAPSED_TAIL_LINES = 12;
/** Live output is unbounded while a command runs, so the running state keeps only a window. */
const STREAM_TAIL_LINES = 12;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
/** The user's home on the two platforms the runner ships for; the browser cannot ask the OS. */
const HOME_PATH = /(?<![\w.-])(?:\/Users|\/home)\/[^/\s]+(?=\/|\s|$)/g;

/** The bash tool's arguments as the frame carries them (src/schemas/bashTool.ts). */
export interface BashCallArgs {
  command?: unknown;
  timeout?: unknown;
  background?: unknown;
  interactive?: unknown;
  name?: unknown;
  alarm?: unknown;
}

/** What formatRunResult reports, read only by the renderers. */
export interface BashResultDetails {
  id?: string;
  runner?: string;
  exitCode?: number | null;
  logPath?: string;
  fileSize?: number;
  lines?: number;
  timedOut?: boolean;
  promoted?: boolean;
  reason?: string;
  tail?: string;
  tailLines?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows the result details to the fields the card reads; anything else is ignored. */
export function bashResultDetails(details: unknown): BashResultDetails {
  if (!isRecord(details)) return {};
  const out: BashResultDetails = {};
  if (typeof details.id === 'string') out.id = details.id;
  if (typeof details.runner === 'string') out.runner = details.runner;
  if (typeof details.exitCode === 'number' || details.exitCode === null) out.exitCode = details.exitCode;
  if (typeof details.logPath === 'string') out.logPath = details.logPath;
  if (typeof details.fileSize === 'number') out.fileSize = details.fileSize;
  if (typeof details.lines === 'number') out.lines = details.lines;
  if (details.timedOut === true) out.timedOut = true;
  if (details.promoted === true) out.promoted = true;
  if (typeof details.reason === 'string') out.reason = details.reason;
  if (typeof details.tail === 'string') out.tail = details.tail;
  if (typeof details.tailLines === 'number') out.tailLines = details.tailLines;
  return out;
}

/** `/Users/me/x` becomes `~/x`. Absolute home paths are what push these lines onto extra rows. */
export function abbreviateHome(text: string): string {
  return text.replace(HOME_PATH, '~');
}

/** Collapse a heredoc or multi-line script to one scannable line plus a count. */
export function collapseCommand(command: string): string {
  const lines = command
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0] ?? '';
  return lines.length > 1 ? `${first} ${ELLIPSIS} +${lines.length - 1} lines` : first;
}

/** Drop the middle rather than the end, so a long pipeline keeps both its source and its sink. */
export function truncateMiddle(text: string, max: number = MAX_COMMAND_LENGTH): string {
  if (text.length <= max) return text;
  const keep = max - GAP.length;
  const head = Math.ceil(keep / 2);
  let start = text.slice(0, head);
  let end = text.slice(text.length - (keep - head));

  // Snap both cuts to a token boundary, so neither side ends mid-word. Each is
  // only moved when a boundary exists in the half nearest the cut, otherwise a
  // single long argument would swallow the whole budget.
  const lastSpace = start.lastIndexOf(' ');
  if (lastSpace > start.length / 2) start = start.slice(0, lastSpace);
  const firstSpace = end.indexOf(' ');
  if (firstSpace >= 0 && firstSpace < end.length / 2) end = end.slice(firstSpace + 1);

  return `${start}${GAP}${end}`;
}

export function formatBashCommand(command: string): string {
  return truncateMiddle(abbreviateHome(collapseCommand(command)));
}

/** Modifiers worth seeing at a glance, in the widget's `·` idiom. */
export function formatBashFlags(args: BashCallArgs): string[] {
  const flags: string[] = [];
  if (args.background === true) flags.push('bg');
  if (args.interactive === true) flags.push('tty');
  if (typeof args.alarm === 'number') flags.push(`alarm ${args.alarm}s`);
  if (typeof args.timeout === 'number') flags.push(`${args.timeout}s`);
  if (typeof args.name === 'string' && args.name.length > 0) flags.push(args.name);
  return flags;
}

/** Human-readable byte count, matching how pi reports output sizes. */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/** The metadata footer, collapsed from five lines to one. */
export function formatResultSummary(details: BashResultDetails): string {
  const parts: string[] = [];
  if (details.lines !== undefined) parts.push(`${details.lines.toLocaleString('en-US')} lines`);
  if (details.fileSize !== undefined) parts.push(formatSize(details.fileSize));
  if (details.runner !== undefined) parts.push(details.runner);
  return parts.join(' · ');
}

/** Last `max` lines, so a chatty command cannot push the transcript off screen. */
function lastLines(text: string, max: number): string[] {
  const all = text.split('\n');
  while (all.length > 0 && all[all.length - 1]?.trim() === '') all.pop();
  return all.length <= max ? all : all.slice(-max);
}

export type BashStatusTone = 'running' | 'ok' | 'error' | 'background';

export interface BashStatusLine {
  glyph: string;
  tone: BashStatusTone;
  text: string;
}

/** What the result body shows: the log lines, then the one-line status under them. */
export interface BashResultView {
  lines: string[];
  status: BashStatusLine | null;
  /** Lines the collapsed view is hiding, so the card can say so. */
  hidden: number;
}

export interface BashResultInput {
  details: unknown;
  /** The result's text blocks joined, all a thrown failure leaves behind. */
  output: string;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}

export function bashResultView(input: BashResultInput): BashResultView {
  const details = bashResultDetails(input.details);

  // Running. Details do not exist yet, so the streamed text is the only source,
  // and it is bounded here because it grows without limit while the command runs.
  if (input.isPartial) {
    return {
      lines: lastLines(input.output, STREAM_TAIL_LINES),
      status: { glyph: '◐', tone: 'running', text: 'running' },
      hidden: 0,
    };
  }

  // Failed. formatRunResult throws on a bad exit, so Pi hands back the error
  // text with no details at all; without this the block would show a bare tick.
  if (input.isError) {
    const all = lastLines(input.output, Number.MAX_SAFE_INTEGER);
    const lines = input.expanded ? all : all.slice(-COLLAPSED_TAIL_LINES);
    const summary = formatResultSummary(details);
    return {
      lines,
      status: { glyph: '✗', tone: 'error', text: summary.length > 0 ? summary : 'failed' },
      hidden: all.length - lines.length,
    };
  }

  if (details.promoted === true) {
    const label = details.runner ?? details.id ?? 'runner';
    const suffix = details.id === undefined ? '' : ` · ${details.id}`;
    return { lines: [], status: { glyph: '●', tone: 'background', text: `${label}${suffix} · background` }, hidden: 0 };
  }

  const all = lastLines(details.tail ?? '', Number.MAX_SAFE_INTEGER);
  const lines = input.expanded ? all : all.slice(-COLLAPSED_TAIL_LINES);
  // An absent exit code means the runner never reported one, which is not a failure.
  const exited = details.exitCode !== undefined && details.exitCode !== null;
  const failed = details.timedOut === true || (exited && details.exitCode !== 0);

  const meta: string[] = [];
  if (details.timedOut === true) meta.push('timed out');
  else if (failed) meta.push(`exit ${details.exitCode}`);
  const summary = formatResultSummary(details);
  if (summary.length > 0) meta.push(summary);

  const text = meta.length > 0 ? meta.join(' · ') : failed ? 'failed' : lines.length === 0 ? 'done' : '';
  return {
    lines,
    status: text.length > 0 ? { glyph: failed ? '✗' : '✓', tone: failed ? 'error' : 'ok', text } : null,
    hidden: all.length - lines.length,
  };
}
