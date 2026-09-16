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

/** Structured rows kept in a collapsed result, before the card is expanded. */
export const COLLAPSED_RESULT_ROWS = 8;

export type SubagentRowTone = 'ok' | 'error' | 'running' | 'idle';

/** One line of a structured subagent result: who, what, and the state flushed right. */
export interface SubagentRow {
  key: string;
  /** The run id or the agent name. */
  label: string;
  /** What it is doing, says, or failed with. Truncates. */
  detail: string;
  /** The state word on the right, empty when the row has none. */
  state: string;
  tone: SubagentRowTone;
}

export type SubagentResultKind = 'agents' | 'run' | 'fleet' | 'status' | 'suspended' | 'control';

/** A finished subagent result as the card shows it, narrowed from the wire details. */
export interface SubagentResultView {
  kind: SubagentResultKind;
  rows: SubagentRow[];
  /** The count under the rows, or a control action's one-line confirmation. */
  summary: string;
  tone: SubagentRowTone;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parts(values: unknown[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '').join(' · ');
}

function firstLine(value: unknown): string {
  return asString(value).split('\n')[0] ?? '';
}

function stateTone(state: string): SubagentRowTone {
  if (state === 'failed' || state === 'error') return 'error';
  if (state === 'complete' || state === 'completed') return 'ok';
  if (state === 'running' || state === 'starting') return 'running';
  return 'idle';
}

function countSummary(count: number, noun: string): string {
  return count === 0 ? `no ${noun}s` : `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function agentsView(value: unknown): SubagentResultView {
  const rows = records(value).map((agent, index) => ({
    key: `${asString(agent.name)}-${index}`,
    label: asString(agent.name),
    detail: preview(asString(agent.description)),
    state: asString(agent.source),
    tone: 'idle' as const,
  }));
  return { kind: 'agents', rows, summary: countSummary(rows.length, 'agent'), tone: 'idle' };
}

function runView(value: unknown): SubagentResultView {
  const outcomes = records(value);
  const rows = outcomes.map((outcome, index) => {
    const runId = asString(outcome.runId);
    return {
      key: runId || `${asString(outcome.agent)}-${index}`,
      label: asString(outcome.agent),
      detail: runId || preview(asString(outcome.error)) || 'unknown error',
      state: runId ? 'started' : 'failed',
      tone: (runId ? 'ok' : 'error') as SubagentRowTone,
    };
  });
  const started = rows.filter((row) => row.state === 'started').length;
  const failed = rows.length - started;
  return {
    kind: 'run',
    rows,
    summary: failed === 0 ? `${started} started` : `${started} started · ${failed} failed`,
    tone: failed === 0 ? 'ok' : 'error',
  };
}

function fleetView(value: unknown): SubagentResultView {
  const rows = records(value).map((job, index) => {
    const state = asString(job.status) || 'starting';
    return {
      key: asString(job.runId) || `run-${index}`,
      label: asString(job.runId),
      detail: preview(parts([job.agent, job.currentTool, job.activityState, job.attentionReason, job.error])),
      state,
      tone: stateTone(state),
    };
  });
  return { kind: 'fleet', rows, summary: countSummary(rows.length, 'run'), tone: 'idle' };
}

function suspendedView(value: unknown): SubagentResultView {
  const runs = isRecord(value) ? [value] : records(value);
  const rows = runs.map((run, index) => {
    const resumable = run.resumable;
    return {
      key: asString(run.runId) || `suspended-${index}`,
      label: asString(run.runId),
      detail: preview(parts([run.agent, firstLine(run.task)])),
      state: resumable === false ? 'not resumable' : resumable === true ? 'resumable' : 'suspended',
      tone: (resumable === false ? 'error' : 'idle') as SubagentRowTone,
    };
  });
  return { kind: 'suspended', rows, summary: countSummary(rows.length, 'suspended run'), tone: 'idle' };
}

function statusView(details: Record<string, unknown>): SubagentResultView {
  const runId = asString(details.runId);
  const status = isRecord(details.status) ? details.status : undefined;
  const state = status ? asString(status.state) : '';
  if (!state) return { kind: 'status', rows: [], summary: `${runId} has no status yet`, tone: 'idle' };
  return {
    kind: 'status',
    rows: [
      {
        key: runId,
        label: runId,
        detail: preview(parts([status?.agent, status?.activityState, status?.summary, status?.error])),
        state,
        tone: stateTone(state),
      },
    ],
    summary: '',
    tone: stateTone(state),
  };
}

function controlView(summary: string, tone: SubagentRowTone): SubagentResultView {
  return { kind: 'control', rows: [], summary, tone };
}

/**
 * Narrows the wire `details` of a subagent result to the rows the card draws.
 * Null when they are not a finished subagent result at all, which is what a
 * partial update or an error message is: the card then falls back to the text.
 */
export function subagentResultView(details: unknown): SubagentResultView | null {
  if (!isRecord(details) || details.partial === true) return null;
  if (Array.isArray(details.agents)) return agentsView(details.agents);
  if (Array.isArray(details.outcomes)) return runView(details.outcomes);
  if (isRecord(details.spawn) && Array.isArray(details.spawn.outcomes)) return runView(details.spawn.outcomes);
  if (Array.isArray(details.runs)) return fleetView(details.runs);
  if (Array.isArray(details.fleet)) return fleetView(details.fleet);
  if (details.suspended !== undefined) return suspendedView(details.suspended);
  if (isRecord(details.control)) {
    return controlView(`stop requested for ${asString(details.runId)}`, 'ok');
  }
  if (isRecord(details.steer)) {
    const state = asString(details.steer.state);
    return controlView(
      `steer ${state}${details.steer.message ? `: ${preview(asString(details.steer.message))}` : ''}`,
      state === 'failed' ? 'error' : 'ok',
    );
  }
  if (isRecord(details.restore)) {
    const restore = details.restore;
    return controlView(`restored ${asString(restore.restoredFrom)} as ${asString(restore.runId)}`, 'ok');
  }
  if (typeof details.runId === 'string') return statusView(details);
  return null;
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
