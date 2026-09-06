/**
 * Pure text shaping for the team tool cards, kept apart from React so the
 * unit suite covers it without a DOM. The shapes mirror what the TUI's
 * subagentToolRender shows; args and details are wire JSON narrowed here.
 */

/** The TUI collapses a result to this many lines until expanded. */
export const COLLAPSED_RESULT_LINES = 12;
const MESSAGE_PREVIEW_CHARS = 72;
const ELLIPSIS = '…';

type Args = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The detail beside the subagent action, as the TUI's callDetails words it. */
export function subagentCallDetail(args: Args): string {
  switch (args.action) {
    case 'agents':
      return asString(args.name);
    case 'run': {
      const requests = Array.isArray(args.requests) ? args.requests : [];
      const agents = requests.map((request) => (isRecord(request) ? asString(request.agent) : '')).filter(Boolean);
      const count = `${requests.length} agent${requests.length === 1 ? '' : 's'}`;
      return agents.length > 0 ? `${count} · ${agents.join(', ')}` : count;
    }
    case 'status':
      return asString(args.id) || 'fleet';
    case 'steer':
    case 'stop':
    case 'restore':
      return asString(args.id);
    case 'suspended':
      return 'runs';
    default:
      return '';
  }
}

/** Result text as lines, trailing blank lines dropped the way the TUI does. */
export function resultLines(output: string): string[] {
  const lines = output.split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines.length === 1 && lines[0] === '' ? [] : lines;
}

export type ResultGlyph = 'running' | 'failed' | 'done' | 'more' | 'none';

export interface ShapedResult {
  lines: string[];
  glyph: ResultGlyph;
  /** Lines hidden by the collapse, for the "more" hint. */
  hidden: number;
}

/**
 * The subagent result body: a tail while running, then the head collapsed to
 * the TUI budget, with the closing glyph line the TUI appends.
 */
export function shapeResult(
  output: string,
  options: { expanded: boolean; isPartial: boolean; isError: boolean },
): ShapedResult {
  const all = resultLines(output);
  if (options.isPartial) {
    return { lines: all.slice(-COLLAPSED_RESULT_LINES), glyph: 'running', hidden: 0 };
  }
  const lines = options.expanded ? all : all.slice(0, COLLAPSED_RESULT_LINES);
  const hidden = all.length - lines.length;
  if (options.isError) return { lines, glyph: 'failed', hidden };
  if (hidden > 0) return { lines, glyph: 'more', hidden };
  if (lines.length === 0) return { lines, glyph: 'done', hidden: 0 };
  return { lines, glyph: 'none', hidden: 0 };
}

function preview(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > MESSAGE_PREVIEW_CHARS ? `${flat.slice(0, MESSAGE_PREVIEW_CHARS - 1)}${ELLIPSIS}` : flat;
}

export interface IntercomCallSummary {
  action: string;
  /** The member or request the action addresses, empty for members and pending. */
  target: string;
  /** A one-line preview of the message body, empty when the action carries none. */
  message: string;
}

/** The intercom call header: action, its target, and what is being said. */
export function intercomCallSummary(args: Args): IntercomCallSummary {
  const action = asString(args.action);
  switch (action) {
    case 'send':
    case 'ask':
      return { action, target: asString(args.to), message: preview(asString(args.message)) };
    case 'reply':
      return { action, target: asString(args.requestId), message: preview(asString(args.message)) };
    default:
      return { action, target: '', message: '' };
  }
}

export type IntercomOutcome = 'delivered' | 'queued' | 'replied' | 'answered' | 'none';

/**
 * The outcome line for a finished intercom call, read from the details the
 * tool attaches: a send is delivered or only queued, a reply confirms its
 * request, an ask carries the answer's sender.
 */
export function intercomOutcome(details: unknown): { outcome: IntercomOutcome; who: string } {
  if (!isRecord(details)) return { outcome: 'none', who: '' };
  if (details.delivered === true) return { outcome: 'delivered', who: asString(details.to) };
  if (details.state === 'queued') return { outcome: 'queued', who: asString(details.to) };
  if (typeof details.reply === 'string') return { outcome: 'answered', who: asString(details.from) };
  if (typeof details.requestId === 'string' && typeof details.to === 'string') {
    return { outcome: 'replied', who: details.to };
  }
  return { outcome: 'none', who: '' };
}
