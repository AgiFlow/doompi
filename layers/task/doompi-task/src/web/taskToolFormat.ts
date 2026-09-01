/**
 * Pure view logic for the task tool card, the browser counterpart of
 * src/tui/format.ts (renderTaskCall, renderTaskResult). The plugin may reach
 * only its own files and src/types, so the store shapes it reads are
 * restated here as the wire JSON of a tool_execution frame.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted';
export type TaskAction = 'upsert' | 'list' | 'get' | 'delete' | 'clear' | 'assign' | 'cancel';

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✗',
  deleted: '⊘',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
  failed: 'failed',
  deleted: 'deleted',
};

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
/** Task rows kept in a collapsed result, before the card is expanded. */
const TRANSCRIPT_TASK_ROWS = 8;
const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'deleted'];
const TASK_ACTIONS: readonly TaskAction[] = ['upsert', 'list', 'get', 'delete', 'clear', 'assign', 'cancel'];
const INLINE_WHITESPACE = /\s+/gu;

/** One task as the result details carry it (src/services/store/types.ts Task). */
export interface TaskView {
  id: number;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
  blockedBy?: number[];
  delegation?: { agent?: string; state?: string };
}

/** The result details (src/services/store/types.ts TaskDetails), narrowed to what the card reads. */
export interface TaskDetailsView {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: TaskView[];
  error?: string;
  upsert?: { applied: number[]; failed: number };
  assignment?: { assigned: number[]; failed: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

function isAction(value: unknown): value is TaskAction {
  return typeof value === 'string' && (TASK_ACTIONS as readonly string[]).includes(value);
}

function taskView(value: unknown): TaskView | null {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.subject !== 'string') return null;
  if (!isStatus(value.status)) return null;
  const task: TaskView = { id: value.id, subject: value.subject, status: value.status };
  if (typeof value.activeForm === 'string') task.activeForm = value.activeForm;
  if (Array.isArray(value.blockedBy)) {
    task.blockedBy = value.blockedBy.filter((id): id is number => typeof id === 'number');
  }
  if (isRecord(value.delegation)) {
    task.delegation = {};
    if (typeof value.delegation.agent === 'string') task.delegation.agent = value.delegation.agent;
    if (typeof value.delegation.state === 'string') task.delegation.state = value.delegation.state;
  }
  return task;
}

function idList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : [];
}

/** Narrows the wire details; null when they are not a task result at all. */
export function taskDetailsView(details: unknown): TaskDetailsView | null {
  if (!isRecord(details) || !isAction(details.action) || !Array.isArray(details.tasks)) return null;
  const view: TaskDetailsView = {
    action: details.action,
    params: isRecord(details.params) ? details.params : {},
    tasks: details.tasks.map(taskView).filter((task): task is TaskView => task !== null),
  };
  if (typeof details.error === 'string') view.error = details.error;
  if (isRecord(details.upsert)) {
    view.upsert = {
      applied: idList(details.upsert.applied),
      failed: typeof details.upsert.failed === 'number' ? details.upsert.failed : 0,
    };
  }
  if (isRecord(details.assignment)) {
    view.assignment = {
      assigned: idList(details.assignment.assigned),
      failed: typeof details.assignment.failed === 'number' ? details.assignment.failed : 0,
    };
  }
  return view;
}

/** `#id` for the wire's id, which the TUI would resolve to a subject through the store. */
function idLabel(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? `#${value}` : '#?';
}

/** Keep dynamic content on one line. */
function inlineText(text: string): string {
  return text.replace(INLINE_WHITESPACE, ' ').trim();
}

export type TaskCallTone = 'dim' | 'accent';

/** The call header: glyph, action, then the subject or a count, as renderTaskCall lays it out. */
export interface TaskCallView {
  glyph: string;
  action: string;
  subject?: string;
  subjectTone: TaskCallTone;
  /** The assignee (`→ agent`) or the list filter. */
  detail?: string;
}

function upsertGlyph(items: readonly Record<string, unknown>[]): string {
  if (items.length === 0) return ACTION_GLYPH.upsert;
  if (items.every((item) => item.id === undefined)) return UPSERT_CREATE_GLYPH;
  if (items.every((item) => item.id !== undefined)) return UPSERT_UPDATE_GLYPH;
  return ACTION_GLYPH.upsert;
}

/**
 * The TUI resolves an id to its subject through the task store; the card has
 * no store and shows `#id` until the result names the task.
 */
export function taskCallView(args: Record<string, unknown>): TaskCallView {
  const action = typeof args.action === 'string' ? args.action : 'task';
  if (!isAction(action)) return { glyph: '?', action, subjectTone: 'dim' };
  const items = action === 'upsert' && Array.isArray(args.tasks) ? args.tasks.filter(isRecord) : [];
  const view: TaskCallView = {
    glyph: action === 'upsert' ? upsertGlyph(items) : ACTION_GLYPH[action],
    action,
    subjectTone: 'dim',
  };

  if (action === 'upsert') {
    // One entry reads exactly as create or update did; a batch reads as a count
    // rather than a subject it would have to pick arbitrarily.
    if (items.length === 1) {
      const only = items[0] ?? {};
      if (only.id === undefined) {
        if (typeof only.subject === 'string') view.subject = inlineText(only.subject);
      } else {
        view.subject = typeof only.subject === 'string' ? inlineText(only.subject) : idLabel(only.id);
        view.subjectTone = 'accent';
      }
    } else if (items.length > 1) {
      view.subject = `${items.length} tasks`;
    }
  } else if (action === 'assign') {
    const assignments = Array.isArray(args.assignments) ? args.assignments.filter(isRecord) : [];
    if (assignments.length === 1) {
      const only = assignments[0] ?? {};
      view.subject = idLabel(only.id);
      view.subjectTone = 'accent';
      if (typeof only.agent === 'string') view.detail = `→ ${only.agent}`;
    } else if (assignments.length > 1) {
      view.subject = `${assignments.length} tasks`;
    }
  } else if ((action === 'get' || action === 'delete' || action === 'cancel') && args.id !== undefined) {
    view.subject = idLabel(args.id);
    view.subjectTone = 'accent';
  } else if (action === 'list' && isStatus(args.status)) {
    view.detail = STATUS_LABEL[args.status];
  }
  return view;
}

/** One row of the result: the task line on the left, its status flushed right. */
export interface TaskRow {
  id: number;
  glyph: string;
  subject: string;
  status: TaskStatus;
  /** Struck through: the task is done with. */
  closed: boolean;
  agent?: string;
  activeForm?: string;
  blockedBy: number[];
}

export type TaskResultTone = 'running' | 'ok' | 'error' | 'warning';

export interface TaskResultView {
  rows: TaskRow[];
  /** Error text lines when the tool threw or the reducer reported an error. */
  errorLines: string[];
  status: { glyph: string; tone: TaskResultTone; text: string } | null;
}

export function taskRow(task: TaskView): TaskRow {
  const row: TaskRow = {
    id: task.id,
    glyph: STATUS_GLYPH[task.status],
    subject: inlineText(task.subject),
    status: task.status,
    closed: task.status === 'completed' || task.status === 'deleted',
    blockedBy: task.blockedBy ?? [],
  };
  if (task.delegation?.agent) row.agent = inlineText(task.delegation.agent);
  if (task.status === 'in_progress' && task.activeForm) row.activeForm = inlineText(task.activeForm);
  return row;
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * The rows `list` reported to the model: `details.tasks` is the whole
 * document, so the call's filters apply again here or the card would disagree
 * with the text the model was given.
 */
function listedTasks(details: TaskDetailsView): TaskView[] {
  let view = details.tasks;
  if (details.params.includeDeleted !== true) view = view.filter((task) => task.status !== 'deleted');
  if (isStatus(details.params.status)) view = view.filter((task) => task.status === details.params.status);
  return view;
}

function byIds(details: TaskDetailsView, ids: readonly number[]): TaskView[] {
  return ids.flatMap((id) => details.tasks.find((task) => task.id === id) ?? []);
}

function batch(
  tasks: readonly TaskView[],
  failed: number,
  verb: string,
  expanded: boolean,
): Pick<TaskResultView, 'rows' | 'status'> {
  // One applied task and nothing failed is the common case: keep the single
  // row it has always had rather than dressing it as a bulk report.
  if (tasks.length === 1 && failed === 0) return { rows: [taskRow(tasks[0] as TaskView)], status: null };
  const shown = expanded ? tasks : tasks.slice(0, TRANSCRIPT_TASK_ROWS);
  let summary = `${tasks.length} ${verb}`;
  if (failed > 0) summary += ` · ${failed} failed`;
  if (tasks.length > shown.length) summary += ` · ${tasks.length - shown.length} more`;
  return {
    rows: shown.map(taskRow),
    status: { glyph: failed > 0 ? '!' : '✓', tone: failed > 0 ? 'warning' : 'ok', text: summary },
  };
}

export function taskResultView(input: {
  details: unknown;
  output: string;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}): TaskResultView {
  const details = taskDetailsView(input.details);

  // Running. `assign` and `cancel` stream a placeholder before the run settles.
  if (input.isPartial) {
    const text = nonEmptyLines(input.output).at(-1) ?? 'working';
    return { rows: [], errorLines: [], status: { glyph: '◐', tone: 'running', text } };
  }

  // Failed. Every failure path throws, so Pi hands back error text and no
  // details; without this the card would show a green tick on a failure.
  if (input.isError || details?.error !== undefined) {
    const all = nonEmptyLines(details?.error ?? input.output);
    if (all.length <= 1) return { rows: [], errorLines: [], status: { glyph: '✗', tone: 'error', text: all[0] ?? '' } };
    const errorLines = input.expanded ? all : all.slice(0, TRANSCRIPT_TASK_ROWS);
    return { rows: [], errorLines, status: { glyph: '✗', tone: 'error', text: '' } };
  }

  if (details === null) return { rows: [], errorLines: [], status: { glyph: '✓', tone: 'ok', text: '' } };

  if (details.action === 'list') {
    const tasks = listedTasks(details);
    const shown = input.expanded ? tasks : tasks.slice(0, TRANSCRIPT_TASK_ROWS);
    let summary = tasks.length === 0 ? 'no tasks' : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
    if (tasks.length > shown.length) summary += ` · ${tasks.length - shown.length} more`;
    return { rows: shown.map(taskRow), errorLines: [], status: { glyph: '✓', tone: 'ok', text: summary } };
  }

  if (details.action === 'clear') {
    return { rows: [], errorLines: [], status: { glyph: '✓', tone: 'ok', text: 'cleared' } };
  }

  if (details.action === 'assign' && details.assignment) {
    const assigned = byIds(details, details.assignment.assigned);
    return { errorLines: [], ...batch(assigned, details.assignment.failed, 'assigned', input.expanded) };
  }

  if (details.action === 'upsert') {
    const touched = byIds(details, details.upsert?.applied ?? []);
    return { errorLines: [], ...batch(touched, details.upsert?.failed ?? 0, 'applied', input.expanded) };
  }

  // The single task an id-bearing action acted on, so the card names it rather than a bare tick.
  const id = details.params.id;
  const task = typeof id === 'number' ? details.tasks.find((candidate) => candidate.id === id) : undefined;
  if (!task) return { rows: [], errorLines: [], status: { glyph: '✓', tone: 'ok', text: '' } };
  return { rows: [taskRow(task)], errorLines: [], status: null };
}
