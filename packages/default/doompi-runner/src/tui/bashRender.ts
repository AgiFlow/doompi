import os from 'node:os';
import { DoomToolCall, renderToolBadge } from '@agimon-ai/doompi-ui/toolChrome';
import { highlightCode, type Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { formatSize } from '../commands/bash/responseEnvelope.ts';
import type { BashParams } from '../schemas/bashTool.ts';

const ELLIPSIS = '…';
/** Spaced so the join never glues two words into one unreadable token. */
const GAP = ' … ';
/** Wide enough to keep a realistic command intact, short enough to stay under three wrapped rows. */
const MAX_COMMAND_LENGTH = 160;

/**
 * Syntax highlighter for the command line.
 *
 * `highlightCode` reads Pi's global theme singleton rather than the theme passed
 * to a renderer, so it is injected here to keep these functions testable.
 */
export type Highlighter = (code: string, lang?: string) => string[];
/** Lines of log kept in the collapsed result, before `ctrl+o` reveals the rest. */
const COLLAPSED_TAIL_LINES = 12;
/** Live output is unbounded while a command runs, so the running state keeps only a window. */
const STREAM_TAIL_LINES = 12;

/**
 * Width-aware tool text.
 *
 * Pi's Text component wraps every long line. That is useful for prose, but it
 * makes shell pipelines and grep output consume several visual rows and blurs
 * the boundary between separate log lines. Collapsed tool output is instead
 * clipped per logical line; expanded output keeps all content by wrapping it.
 */
interface BashToolTextLayout {
  wrap: boolean;
  separator?: (line: string) => string;
  trailingBlank?: boolean;
}

class BashToolText implements Component {
  constructor(
    private readonly lines: readonly string[],
    private readonly layout: BashToolTextLayout,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const contentWidth = Math.max(1, width - 2);
    const rendered = this.layout.wrap
      ? this.lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      : this.lines.map((line) => truncateToWidth(line, contentWidth, ELLIPSIS));
    if (this.layout.separator) rendered.unshift(this.layout.separator('─'.repeat(contentWidth)));
    const padded = rendered.map((line) => ` ${line}`);
    if (this.layout.trailingBlank) padded.push('');
    return padded;
  }

  invalidate(): void {
    // Content is immutable and rendering reads the current width every time.
  }
}

function renderResultText(lines: readonly string[], wrap: boolean, theme: Theme): Component {
  return new BashToolText(lines, {
    wrap,
    // State belongs in the result summary below; keep this divider structural.
    separator: (line) => theme.fg('borderMuted', line),
    trailingBlank: true,
  });
}

/** An SGR colour sequence, the only escape the log pipeline is allowed to keep. */
/* oxlint-disable no-control-regex -- matching SGR requires the ESC control character */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Matching SGR requires the ESC control character.
const SGR_PATTERN = /\u001b\[[0-9;]*m/;
/* oxlint-enable no-control-regex */

/**
 * Applies a theme colour only to lines that carry none of their own.
 *
 * A command that emits colour has already said how its output should look, and
 * wrapping it would reset to the terminal default at the first embedded escape.
 */
function paint(line: string, color: ThemeColor, theme: Theme): string {
  return SGR_PATTERN.test(line) ? line : theme.fg(color, line);
}

/** Structured view of what `formatRunResult` reports, read only by the renderers. */
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

/** `/Users/me/x` becomes `~/x`. Absolute home paths are what push these lines onto extra rows. */
export function abbreviateHome(text: string, home: string = os.homedir()): string {
  return home.length > 0 ? text.split(home).join('~') : text;
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
  return abbreviateHome(collapseCommand(command));
}

/** Modifiers worth seeing at a glance, in the widget's `·` idiom. */
export function formatBashFlags(args: BashParams): string[] {
  const flags: string[] = [];
  if (args.background === true) flags.push('bg');
  if (args.interactive === true) flags.push('tty');
  if (args.alarm !== undefined) flags.push(`alarm ${args.alarm}s`);
  if (args.timeout !== undefined) flags.push(`${args.timeout}s`);
  if (args.name !== undefined && args.name.length > 0) flags.push(args.name);
  return flags;
}

export function renderBashCall(args: BashParams, theme: Theme, highlight: Highlighter = highlightCode): Component {
  // Highlight after collapsing multi-line scripts: ANSI codes would break that transformation.
  const command = highlight(formatBashCommand(args.command), 'bash').join(' ');
  let text = `${renderToolBadge('bash', theme)} ${command}`;
  const flags = formatBashFlags(args);
  if (flags.length > 0) text += ` ${theme.fg('muted', `· ${flags.join(' · ')}`)}`;
  // A command is operator input, not log output: wrap it so the complete
  // pipeline remains inspectable instead of clipping its most important tail.
  return new DoomToolCall(text);
}

/** The metadata footer, collapsed from five lines to one. */
export function formatResultSummary(details: BashResultDetails): string {
  const parts: string[] = [];
  if (details.lines !== undefined) parts.push(`${details.lines.toLocaleString('en-US')} lines`);
  if (details.fileSize !== undefined) parts.push(formatSize(details.fileSize));
  if (details.runner !== undefined) parts.push(details.runner);
  return parts.join(' · ');
}

function tailLines(details: BashResultDetails, expanded: boolean): string[] {
  const lines = (details.tail ?? '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (expanded || lines.length <= COLLAPSED_TAIL_LINES) return lines;
  return lines.slice(-COLLAPSED_TAIL_LINES);
}

/** Concatenated text of a tool result, which is all a thrown failure leaves behind. */
function contentText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('');
}

/** Last `max` lines, so a chatty command cannot push the transcript off screen. */
function lastLines(text: string, max: number): string[] {
  const all = text.split('\n');
  while (all.length > 0 && all[all.length - 1]?.trim() === '') all.pop();
  return all.length <= max ? all : all.slice(-max);
}

export function renderBashResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean; isError?: boolean },
  theme: Theme,
): Component {
  const details = (result.details ?? {}) as BashResultDetails;

  // Running. Details do not exist yet, so the streamed text is the only source,
  // and it is bounded here because it grows without limit while the command runs.
  if (options.isPartial) {
    const streamed = lastLines(contentText(result), STREAM_TAIL_LINES);
    const label = theme.fg('warning', '◐') + theme.fg('dim', ' running');
    return renderResultText([...streamed.map((line) => paint(line, 'toolOutput', theme)), label], false, theme);
  }

  // Failed. formatRunResult throws on a bad exit, so Pi hands back the error
  // text with no details at all; without this the block would render a bare tick.
  if (options.isError === true) {
    const body = lastLines(contentText(result), options.expanded ? Number.MAX_SAFE_INTEGER : COLLAPSED_TAIL_LINES);
    const summary = formatResultSummary(details);
    const meta = summary.length > 0 ? ` ${summary}` : ' failed';
    return renderResultText(
      [...body.map((line) => paint(line, 'toolOutput', theme)), theme.fg('error', '✗') + theme.fg('dim', meta)],
      options.expanded,
      theme,
    );
  }

  if (details.promoted === true) {
    const label = details.runner ?? details.id ?? 'runner';
    const suffix = details.id === undefined ? '' : ` · ${details.id}`;
    return renderResultText(
      [theme.fg('accent', `● ${label}`) + theme.fg('muted', `${suffix} · background`)],
      false,
      theme,
    );
  }

  const body = tailLines(details, options.expanded);
  // An absent exit code means the runner never reported one, which is not a failure.
  const exited = details.exitCode !== undefined && details.exitCode !== null;
  const failed = details.timedOut === true || (exited && details.exitCode !== 0);
  const glyph = failed ? theme.fg('error', '✗') : theme.fg('success', '✓');

  const meta: string[] = [];
  if (details.timedOut === true) meta.push('timed out');
  else if (failed) meta.push(`exit ${details.exitCode}`);
  const summary = formatResultSummary(details);
  if (summary.length > 0) meta.push(summary);
  if (!options.expanded && (details.tailLines ?? 0) > body.length) meta.push('ctrl+o');

  const lines = body.map((line) => paint(line, 'toolOutput', theme));
  // `dim`, not `muted`: muted sits too close to toolOutput to read as chrome.
  const status = meta.length > 0 ? ` ${meta.join(' · ')}` : failed ? ' failed' : body.length === 0 ? ' done' : '';
  if (status.length > 0) lines.push(glyph + theme.fg('dim', status));
  return renderResultText(lines, options.expanded, theme);
}
