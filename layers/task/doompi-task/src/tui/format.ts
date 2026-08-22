import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import { DoomToolCall, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { DelegationManager, type DelegationProgress } from '../services/delegation/manager.ts';
import type {
  Task,
  TaskAction,
  TaskDetails,
  TaskItemMutation,
  TaskMutationParams,
  TaskStatus,
} from '../services/store/types.ts';

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✗',
  deleted: '⊘',
};

type TaskStatusColor = 'dim' | 'warning' | 'success' | 'error' | 'muted';

export const STATUS_COLOR: Record<TaskStatus, TaskStatusColor> = {
  pending: 'dim',
  in_progress: 'warning',
  completed: 'success',
  failed: 'error',
  deleted: 'muted',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
  failed: 'failed',
  deleted: 'deleted',
};

const OVERLAY_STATUS_GLYPH: Record<TaskStatus, string> = {
  ...STATUS_GLYPH,
  completed: '✓',
  deleted: STATUS_GLYPH.failed,
};

const OVERLAY_STATUS_COLOR: Record<TaskStatus, TaskStatusColor> = {
  ...STATUS_COLOR,
  deleted: 'error',
};
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const TOKENS_PER_KILO = 1000;
const TOKEN_DECIMAL_LIMIT = 10_000;
const REDUNDANT_WORKING_PREFIX = /^working:\s*/i;
const INLINE_WHITESPACE = /\s+/gu;

/** Keep dynamic content inside the overlay's one-physical-line contract. */
function inlineText(text: string): string {
  return text.replace(INLINE_WHITESPACE, ' ').trim();
}

/** Thinking text already communicates activity; keep only its useful content. */
function progressText(currentTool: string | undefined): string | undefined {
  if (!currentTool) return undefined;
  const text = inlineText(currentTool.replace(REDUNDANT_WORKING_PREFIX, ''));
  return text || undefined;
}

export const ACTION_GLYPH: Record<TaskAction, string> = {
  upsert: '✎',
  delete: '×',
  get: '›',
  list: '☰',
  clear: '∅',
  assign: '⇒',
  cancel: '⊗',
};

/**
 * `upsert` is two operations behind one name, so a homogeneous batch narrows to
 * the glyph the operator already reads: `+` means new work appeared, `→` means
 * work moved. A mixed batch keeps the neutral write glyph.
 */
const UPSERT_CREATE_GLYPH = '+';
const UPSERT_UPDATE_GLYPH = '→';

function upsertGlyph(items: readonly TaskItemMutation[]): string {
  if (items.length === 0) return ACTION_GLYPH.upsert;
  if (items.every((item) => item.id === undefined)) return UPSERT_CREATE_GLYPH;
  if (items.every((item) => item.id !== undefined)) return UPSERT_UPDATE_GLYPH;
  return ACTION_GLYPH.upsert;
}

export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
  return theme.fg(OVERLAY_STATUS_COLOR[status], OVERLAY_STATUS_GLYPH[status]);
}

export function formatElapsedMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / MILLISECONDS_PER_SECOND));
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) {
    return totalMinutes === 0 ? `${seconds}s` : `${totalMinutes}m${String(seconds).padStart(2, '0')}s`;
  }
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
}

export function formatTokenCount(tokens: number): string {
  const count = Math.max(0, Math.round(tokens));
  if (count < TOKENS_PER_KILO) return String(count);
  if (count < TOKEN_DECIMAL_LIMIT) return `${(count / TOKENS_PER_KILO).toFixed(1)}k`;
  return `${Math.round(count / TOKENS_PER_KILO)}k`;
}

/**
 * One task row for the persistent overlay.
 *
 * A delegated row carries the agent name and its current tool so the operator
 * can see that background work is progressing without opening a transcript.
 */
export function formatOverlayTaskLine(
  task: Task,
  theme: Theme,
  showId: boolean,
  progress?: DelegationProgress,
  nowMs = Date.now(),
  agentColor?: Parameters<Theme['fg']>[0],
): string {
  const subjectColor =
    task.status === 'in_progress'
      ? 'accent'
      : task.status === 'completed' || task.status === 'deleted'
        ? 'muted'
        : 'text';
  let subject = theme.fg(subjectColor, inlineText(task.subject));
  if (task.status === 'completed' || task.status === 'deleted') {
    subject = theme.strikethrough(subject);
  }

  let line = overlayStatusGlyph(task.status, theme);
  if (showId) line += ` ${theme.fg('dim', `#${task.id}`)}`;
  line += ` ${subject}`;

  const agent = task.delegation?.agent;
  const agentLabel = agent ? inlineText(agent) : undefined;
  if (agentLabel && task.delegation?.state === 'running') {
    // No progress means no timing is known, so the chips are omitted rather than
    // reported as `[0s]`. The transcript renderer has no progress feed at all.
    const chips: string[] = [];
    if (progress) {
      chips.push(theme.fg('muted', `[${formatElapsedMs(DelegationManager.elapsedMs(progress, nowMs))}]`));
      if (progress.tokens !== undefined) chips.push(theme.fg('muted', `[${formatTokenCount(progress.tokens)}]`));
    }
    const identity = task.delegation.runId ?? task.delegation.requestId;
    chips.push(theme.fg(agentColor ?? agentIdentityColor(identity), `[${agentLabel}]`));
    line += ` ${chips.join('')}`;
    const activity = progressText(progress?.currentTool);
    if (activity) line += ` ${theme.fg('muted', `· ${activity}`)}`;
  } else if (agentLabel) {
    line += ` ${theme.fg('muted', `[${agentLabel}]`)}`;
  }

  if (task.status === 'in_progress' && task.activeForm) {
    line += ` ${theme.fg('muted', `(${inlineText(task.activeForm)})`)}`;
  }
  if (task.blockedBy?.length) {
    line += ` ${theme.fg('muted', `⛓ ${task.blockedBy.map((id) => `#${id}`).join(',')}`)}`;
  }
  return line;
}

/** One task line for the `/tasks` command output. */
export function formatCommandTaskLine(task: Task, glyph: string): string {
  const form = task.status === 'in_progress' && task.activeForm ? ` (${task.activeForm})` : '';
  const agent = task.delegation?.agent ? ` [${task.delegation.agent}]` : '';
  const block = task.blockedBy?.length ? `    ⛓ ${task.blockedBy.map((id) => `#${id}`).join(',')}` : '';
  return `  ${glyph} #${task.id} ${task.subject}${form}${agent}${block}`;
}

export function renderTaskCall(
  args: TaskMutationParams & { action: TaskAction },
  theme: Theme,
  tasks: readonly Task[],
): Component {
  const items = args.action === 'upsert' ? (args.tasks ?? []) : [];
  const glyph = args.action === 'upsert' ? upsertGlyph(items) : (ACTION_GLYPH[args.action] ?? args.action);
  let text = renderToolHeading('task', `${glyph} ${args.action}`, theme);

  if (args.action === 'upsert') {
    // One entry reads exactly as create or update did; a batch reads as a count
    // rather than a subject it would have to pick arbitrarily.
    if (items.length === 1) {
      const only = items[0];
      if (only.id === undefined) {
        if (only.subject) text += ` ${theme.fg('dim', only.subject)}`;
      } else {
        const subject = tasks.find((task) => task.id === only.id)?.subject ?? only.subject ?? `#${only.id}`;
        text += ` ${theme.fg('accent', subject)}`;
      }
    } else if (items.length > 1) {
      text += ` ${theme.fg('dim', `${items.length} tasks`)}`;
    }
  } else if (args.action === 'assign') {
    const assignments = args.assignments ?? [];
    if (assignments.length === 1) {
      const only = assignments[0];
      const subject = tasks.find((task) => task.id === only.id)?.subject ?? `#${only.id}`;
      text += ` ${theme.fg('accent', subject)}`;
      if (only.agent) text += ` ${theme.fg('muted', `→ ${only.agent}`)}`;
    } else if (assignments.length > 1) {
      text += ` ${theme.fg('dim', `${assignments.length} tasks`)}`;
    }
  } else if ((args.action === 'get' || args.action === 'delete' || args.action === 'cancel') && args.id !== undefined) {
    const subject = tasks.find((task) => task.id === args.id)?.subject ?? `#${args.id}`;
    text += ` ${theme.fg('accent', subject)}`;
  } else if (args.action === 'list' && args.status) {
    text += ` ${theme.fg('muted', STATUS_LABEL[args.status])}`;
  }
  return new DoomToolCall(text);
}

/** Task rows kept in a collapsed result, before `ctrl+o` reveals the rest. */
const TRANSCRIPT_TASK_ROWS = 8;
/** Minimum gap between a row's subject and its right-aligned status. */
const STATUS_GUTTER = 2;

export interface JustifiedRow {
  left: string;
  /** Pinned to the right edge. The subject is truncated before this is dropped. */
  right?: string;
}

/**
 * Rows whose trailing text is flushed right.
 *
 * `Text` cannot do this: the status has to be placed against the viewport edge,
 * which is only known at render time.
 */
export class JustifiedRows implements Component {
  constructor(private readonly rows: readonly JustifiedRow[]) {}

  /**
   * Nothing to discard: the rows are themed by the caller and held verbatim, and
   * Pi rebuilds this component from `renderResult` whenever the theme changes.
   */
  invalidate(): void {}

  render(width: number): string[] {
    return this.rows.map(({ left, right }) => {
      if (right === undefined || right.length === 0) return truncateToWidth(left, width);
      const rightWidth = visibleWidth(right);
      const room = width - rightWidth - STATUS_GUTTER;
      if (room <= 0) return truncateToWidth(left, width);
      const subject = truncateToWidth(left, room);
      const gap = Math.max(STATUS_GUTTER, width - visibleWidth(subject) - rightWidth);
      return subject + ' '.repeat(gap) + right;
    });
  }
}

/**
 * Self-owned task shell with the same structural divider as the bash tool.
 *
 * Task rows already carry precise per-task state, so the divider stays neutral
 * instead of competing with or appearing to animate between those states.
 */
class TaskResultFrame implements Component {
  constructor(
    private readonly content: Component,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 3) return this.content.render(width);

    const contentWidth = width - 2;
    const divider = this.theme.fg('borderMuted', '─'.repeat(contentWidth));
    const lines = this.content.render(contentWidth).map((line) => ` ${line}`);
    return [` ${divider}`, ...lines, ''];
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

export interface TaskResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface TaskResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

/** Concatenated result text, which is all a thrown failure leaves behind. */
function contentText(result: TaskResultLike): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('');
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * The rows `list` reported to the model.
 *
 * `details.tasks` is the whole post-mutation document, so the filters applied by
 * `formatContent` have to be applied again here or the transcript would disagree
 * with the text the model was given.
 */
function listedTasks(details: TaskDetails): Task[] {
  const params = details.params as TaskMutationParams;
  let view = details.tasks;
  if (params.includeDeleted !== true) view = view.filter((task) => task.status !== 'deleted');
  if (params.status) view = view.filter((task) => task.status === params.status);
  return view;
}

/** The single task an id-bearing action acted on, so the transcript names it rather than a bare tick. */
function subjectTask(details: TaskDetails): Task | undefined {
  const params = details.params as TaskMutationParams;
  if (params.id === undefined) return undefined;
  return details.tasks.find((task) => task.id === params.id);
}

/**
 * Tasks an upsert applied, resolved from the ids the reducer reported.
 *
 * The ids are read rather than guessed from the tail of the list: a batch
 * touches many rows, and a failed entry contributes none.
 */
function upsertTasks(details: TaskDetails): Task[] {
  return (details.upsert?.applied ?? []).flatMap((id) => details.tasks.find((task) => task.id === id) ?? []);
}

/** Tasks successfully handed off by a native assignment batch. */
function assignedTasks(details: TaskDetails): Task[] {
  return (details.assignment?.assigned ?? []).flatMap((id) => details.tasks.find((task) => task.id === id) ?? []);
}

function renderTaskResultBody(result: TaskResultLike, options: TaskResultOptions, theme: Theme): Component {
  const details = result.details as TaskDetails | undefined;

  // Running. `assign` and `cancel` stream a placeholder before the run settles.
  if (options.isPartial) {
    const text = nonEmptyLines(contentText(result)).at(-1) ?? 'working';
    return new Text(theme.fg('warning', '◐') + theme.fg('dim', ` ${text}`), 0, 0);
  }

  // Failed. Every failure path throws, so Pi hands back error text and no
  // details; without this the block would render a green tick on a failure.
  if (result.isError === true || details?.error !== undefined) {
    const message = details?.error ?? contentText(result);
    const all = nonEmptyLines(message);
    if (all.length <= 1) {
      return new Text(theme.fg('error', '✗') + theme.fg('dim', all[0] ? ` ${all[0]}` : ''), 0, 0);
    }
    const body = options.expanded ? all : all.slice(0, TRANSCRIPT_TASK_ROWS);
    return new Text([...body.map((line) => theme.fg('toolOutput', line)), theme.fg('error', '✗')].join('\n'), 0, 0);
  }

  if (!details) return new Text(theme.fg('success', '✓'), 0, 0);

  /** Status rides on the task's own row, flushed right, rather than costing a line. */
  const row = (task: Task): JustifiedRow => ({
    left: formatOverlayTaskLine(task, theme, true),
    right: theme.fg(STATUS_COLOR[task.status], STATUS_LABEL[task.status]),
  });

  if (details.action === 'list') {
    const tasks = listedTasks(details);
    const shown = options.expanded ? tasks : tasks.slice(0, TRANSCRIPT_TASK_ROWS);
    const rows: JustifiedRow[] = shown.map(row);
    let summary = tasks.length === 0 ? 'no tasks' : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
    if (tasks.length > shown.length) summary += ' · ctrl+o';
    rows.push({ left: theme.fg('success', '✓') + theme.fg('dim', ` ${summary}`) });
    return new JustifiedRows(rows);
  }

  if (details.action === 'clear') {
    return new Text(theme.fg('success', '✓') + theme.fg('dim', ' cleared'), 0, 0);
  }

  if (details.action === 'assign' && details.assignment) {
    const assigned = assignedTasks(details);
    const failed = details.assignment.failed;
    if (assigned.length === 1 && failed === 0) return new JustifiedRows([row(assigned[0])]);

    const shown = options.expanded ? assigned : assigned.slice(0, TRANSCRIPT_TASK_ROWS);
    const rows: JustifiedRow[] = shown.map(row);
    let summary = `${assigned.length} assigned`;
    if (failed > 0) summary += ` · ${failed} failed`;
    if (assigned.length > shown.length) summary += ' · ctrl+o';
    const mark = failed > 0 ? theme.fg('warning', '!') : theme.fg('success', '✓');
    rows.push({ left: mark + theme.fg('dim', ` ${summary}`) });
    return new JustifiedRows(rows);
  }

  if (details.action === 'upsert') {
    const touched = upsertTasks(details);
    const failed = details.upsert?.failed ?? 0;
    // One applied task and nothing failed is the common case: keep the single
    // row it has always had rather than dressing it as a bulk report.
    if (touched.length === 1 && failed === 0) return new JustifiedRows([row(touched[0])]);

    const shown = options.expanded ? touched : touched.slice(0, TRANSCRIPT_TASK_ROWS);
    const rows: JustifiedRow[] = shown.map(row);
    let summary = `${touched.length} applied`;
    if (failed > 0) summary += ` · ${failed} failed`;
    if (touched.length > shown.length) summary += ' · ctrl+o';
    // Failed entries get no row: there is no task to render, and their messages
    // are already in the text the model was given.
    const mark = failed > 0 ? theme.fg('warning', '!') : theme.fg('success', '✓');
    rows.push({ left: mark + theme.fg('dim', ` ${summary}`) });
    return new JustifiedRows(rows);
  }

  const task = subjectTask(details);
  if (!task) return new Text(theme.fg('success', '✓'), 0, 0);
  return new JustifiedRows([row(task)]);
}

export function renderTaskResult(result: TaskResultLike, options: TaskResultOptions, theme: Theme): Component {
  return new TaskResultFrame(renderTaskResultBody(result, options, theme), theme);
}
