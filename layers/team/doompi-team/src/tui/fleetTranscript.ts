import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { formatDuration, shortenPath } from '../services/displayFormat';
import type { FleetTranscriptEvent, FleetTranscriptTail } from '../services/fleetTranscript';
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
