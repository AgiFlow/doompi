/**
 * Task Space: the `SPC t l` overlay.
 *
 * The task list and detail pane render from plain values so the whole surface
 * can be asserted as text without a live terminal.
 *
 * The overlay reads the store on every render rather than caching rows, so an
 * external write by a delegated child shows up without closing the overlay.
 *
 * Every commit it makes is a single-entry `upsert` that carries the selected
 * task's id. That id is what keeps creating a task a tool-only path: an entry
 * without one would create rather than be rejected.
 */

import { homedir } from 'node:os';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import { fitStyledLine } from '@agimon-ai/doompi-ui/rendering';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { MSG_NO_TASKS, TASK_STATUSES } from '../schemas/task.ts';
import { applyTaskMutation, isCommittingOp, type Op, singleItemOutcome } from '../services/store/reducer.ts';
import { isBlocked } from '../services/store/taskGraph.ts';
import type { TaskStore } from '../adapters/store/taskStore';
import type { Task, TaskItemMutation } from '../services/store/types.ts';
import { overlayStatusGlyph, STATUS_LABEL } from './format.ts';
import { countTasks, visibleTasks } from './selectors.ts';

export const TASK_SPACE_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;

export interface TaskSpaceOptions {
  store: TaskStore;
}

type EditMode = 'browse' | 'status' | 'subject';

const KEY_BACKSPACE = '\x7f';
const KEY_ENTER = '\r';
const KEY_NEWLINE = '\n';
const FIRST_PRINTABLE_CODE_POINT = 0x20;
const DELETE_CODE_POINT = 0x7f;

/**
 * Keystrokes that carry no text: escape sequences, control keys, delete.
 * Indexed rather than iterated so surrogate pairs stay intact; both halves sit
 * far above the control range, so no emoji is ever mistaken for one.
 */
function isControlInput(data: string): boolean {
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT) return true;
  }
  return false;
}

/**
 * Store path for the list heading: home collapses to `~`, and an over-long path
 * loses leading segments rather than its tail, because the file name identifies
 * the store while `/var/folders/...` does not.
 */
function storeLabel(storePath: string, width: number): string {
  const home = homedir();
  const abbreviated = home && storePath.startsWith(home) ? `~${storePath.slice(home.length)}` : storePath;
  if (visibleWidth(abbreviated) <= width) return abbreviated;

  const segments = abbreviated.split('/');
  let tail = segments.pop() ?? abbreviated;
  while (segments.length > 0) {
    const candidate = `${segments[segments.length - 1]}/${tail}`;
    if (visibleWidth(`…/${candidate}`) > width) break;
    tail = candidate;
    segments.pop();
  }
  return truncateToWidth(`…/${tail}`, width, '');
}

/** Neither palette name is exported, so take both from the theme's methods. */
type ThemeBg = Parameters<Theme['bg']>[0];
type ThemeColor = Parameters<Theme['fg']>[0];

/** Each task occupies a heading row and a metadata row beneath it. */
const ROWS_PER_TASK = 2;
/** Hanging indent for the metadata row: clears marker, glyph and id. */
const META_INDENT = 6;

const MIN_WIDTH = 48;
/** A third for the list, two thirds for the task being read or edited. */
const LIST_PANE_RATIO = 1 / 3;
/** One blank column each side of the pane divider so neither column touches it. */
const PANE_GUTTER = 1;
const MIN_PANE_WIDTH = 18;
const SELECTION_MARKER = '›';
const CURRENT_MARKER = '▸';
const CURSOR_BLOCK = '█';
const ELLIPSIS = '…';
const NO_VALUE = 'none';

const TITLE = 'TASK SPACE';
const BREADCRUMB = 'SPC › t › t / tasks';
/** Key/label pairs rendered as capped keys, matching the mockup's footer. */
const LIST_HINTS: readonly (readonly [string, string])[] = [
  ['↑↓', 'select'],
  ['enter', 'edit subject'],
  ['s', 'status'],
  ['esc', 'close'],
];
const LIST_HEADER_RIGHT = 'esc close';
const STATUS_HINT = 'STATUS   s cycles · enter commits';
const SUBJECT_HINT = 'SUBJECT  enter commits · esc cancels';
function fitRow(text: string, width: number): string {
  return fitStyledLine(text, width, ELLIPSIS);
}

function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fitRow(left, leftWidth) + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + fitRow(right, rightWidth);
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Task Space overlay component.
 *
 * Rendering is pure: `render(width)` reads the live store and returns lines with
 * no side effects, so the fidelity job can capture it and unit tests can assert on it.
 */
export class TaskSpaceComponent extends DoomOverlay {
  private readonly options: TaskSpaceOptions;
  private readonly done: (result: undefined) => void;
  private readonly unwatch: () => void;

  private mode: EditMode = 'browse';
  private selected = 0;
  private statusIndex = 0;
  private draft = '';
  private notice: string | undefined;
  private bodyHeight = 1;

  constructor(tui: DoomOverlayTui, theme: Theme, options: TaskSpaceOptions, done: (result: undefined) => void) {
    super(tui, theme);
    this.options = options;
    this.done = done;
    this.unwatch = options.store.onExternalChange(() => this.tui.requestRender());
  }

  private tasks(): Task[] {
    return visibleTasks(this.options.store.snapshot.tasks);
  }

  private selectedTask(): Task | undefined {
    const tasks = this.tasks();
    if (tasks.length === 0) return undefined;
    return tasks[Math.min(this.selected, tasks.length - 1)];
  }

  private move(delta: number): void {
    const tasks = this.tasks();
    if (tasks.length === 0) return;
    this.selected = Math.max(0, Math.min(tasks.length - 1, this.selected + delta));
    this.tui.requestRender();
  }

  /** Commits through the same reducer the task tool uses, so both paths share every invariant. */
  private commit(item: TaskItemMutation): void {
    this.options.store
      .mutate<Op>((document) => {
        const result = applyTaskMutation(document, 'upsert', { tasks: [item] });
        // A rejected mutation must not reach the writer: committing it would
        // bump `rev` for an edit that never happened.
        if (!isCommittingOp(result.op)) return { value: result.op };
        return { document: result.document, value: result.op };
      })
      .then((outcome) => {
        // The reducer's message is unprefixed, so the notice reads
        // "subject must not be blank" rather than "item[0] failed: ...".
        const single = singleItemOutcome(outcome.value);
        this.notice = single?.kind === 'failed' ? single.message : undefined;
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        // Shown in the overlay rather than swallowed: a rejected write means the
        // edit the operator just made never landed.
        this.notice = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
  }

  private handleStatusInput(data: string): void {
    const task = this.selectedTask();
    if (matchesKey(data, 'up')) this.statusIndex = Math.max(0, this.statusIndex - 1);
    else if (matchesKey(data, 'down')) this.statusIndex = Math.min(TASK_STATUSES.length - 1, this.statusIndex + 1);
    else if (data === 's') this.statusIndex = (this.statusIndex + 1) % TASK_STATUSES.length;
    else if (data === KEY_ENTER || data === KEY_NEWLINE) {
      this.mode = 'browse';
      if (task) this.commit({ id: task.id, status: TASK_STATUSES[this.statusIndex] });
    } else if (matchesKey(data, 'escape')) this.mode = 'browse';
    this.tui.requestRender();
  }

  private handleSubjectInput(data: string): void {
    const task = this.selectedTask();
    if (data === KEY_ENTER || data === KEY_NEWLINE) {
      this.mode = 'browse';
      if (task) this.commit({ id: task.id, subject: this.draft });
    } else if (matchesKey(data, 'escape')) this.mode = 'browse';
    else if (data === KEY_BACKSPACE) this.draft = this.draft.slice(0, -1);
    else if (!isControlInput(data)) this.draft += data;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === 'status') {
      this.handleStatusInput(data);
      return;
    }
    if (this.mode === 'subject') {
      this.handleSubjectInput(data);
      return;
    }

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, 'up')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.move(1);
      return;
    }

    const task = this.selectedTask();
    if (!task) return;
    if (data === 's') {
      this.mode = 'status';
      this.statusIndex = Math.max(0, TASK_STATUSES.indexOf(task.status));
      this.tui.requestRender();
      return;
    }
    if (data === KEY_ENTER || data === KEY_NEWLINE) {
      this.mode = 'subject';
      this.draft = task.subject;
      this.tui.requestRender();
    }
  }

  /**
   * A padded, background-filled chip. Foreground is applied inside the fill so
   * the colour closes with it, rather than a reset stripping the background
   * partway through the label.
   */
  private badge(text: string, background: ThemeBg, colour: ThemeColor = 'text'): string {
    return this.theme.bg(background, this.theme.fg(colour, ` ${text} `));
  }

  /** Footer hints as capped keys: `[ enter ] edit subject`, per the mockup. */
  private hintLine(hints: readonly (readonly [string, string])[]): string {
    return hints
      .map(([key, label]) => `${this.badge(key, 'selectedBg')}${this.theme.fg('dim', ` ${label}`)}`)
      .join(this.theme.fg('dim', '   '));
  }

  private listLines(width: number): string[] {
    const tasks = this.tasks();
    const label = this.theme.bold('TASKS');
    const pathWidth = Math.max(0, width - visibleWidth('TASKS') - 2);
    const lines = [`${label}  ${this.theme.fg('dim', storeLabel(this.options.store.storePath, pathWidth))}`, ''];
    if (tasks.length === 0) {
      lines.push(this.theme.fg('dim', MSG_NO_TASKS));
      return lines;
    }

    // Two rows per task: at a third of the width a single row left the subject
    // with a handful of columns once owner and state took their share.
    const budget = Math.max(1, Math.floor((this.bodyHeight - lines.length) / ROWS_PER_TASK));
    const start = Math.max(0, Math.min(this.selected - budget + 1, Math.max(0, tasks.length - budget)));
    for (const [offset, task] of tasks.slice(start, start + budget).entries()) {
      const index = start + offset;
      const active = index === Math.min(this.selected, tasks.length - 1);
      const marker = active ? this.theme.fg('accent', SELECTION_MARKER) : ' ';
      const subject = active ? this.theme.bold(task.subject) : task.subject;
      const glyph = overlayStatusGlyph(task.status, this.theme);
      const owner = task.owner ?? task.delegation?.agent ?? NO_VALUE;
      const blocked = task.status === 'pending' && isBlocked(this.options.store.snapshot.tasks, task);
      const state = blocked
        ? this.theme.fg('warning', `blocked by ${(task.blockedBy ?? []).map((id) => `#${id}`).join(', ')}`)
        : this.theme.fg('dim', STATUS_LABEL[task.status]);
      // Subject owns the first row outright; the metadata hangs under it.
      const heading = `${marker} ${glyph} ${this.theme.fg('dim', `#${task.id}`)} ${subject}`;
      const meta = `${' '.repeat(META_INDENT)}${this.badge(owner, 'userMessageBg', 'muted')} ${state}`;
      // Every task sits on a band, the selected one a shade lighter, as in the
      // mockup; the marker stays so selection survives themes with no background.
      const background: ThemeBg = active ? 'selectedBg' : 'userMessageBg';
      for (const row of [heading, meta]) {
        lines.push(this.theme.bg(background, fitRow(row, width)));
      }
    }
    return lines;
  }

  private statusLines(task: Task, width: number): string[] {
    if (this.mode !== 'status') {
      const glyph = overlayStatusGlyph(task.status, this.theme);
      return [this.theme.fg('dim', 'STATUS'), `${glyph} ${STATUS_LABEL[task.status]}`];
    }
    // Editing draws the picker as a filled panel, so the whole option list reads
    // as one surface rather than five loose rows.
    const lines = [this.theme.fg('dim', STATUS_HINT)];
    for (const [index, status] of TASK_STATUSES.entries()) {
      const selected = index === this.statusIndex;
      const marker = selected ? this.theme.fg('accent', CURRENT_MARKER) : ' ';
      const label = selected ? this.theme.bold(this.theme.fg('accent', status)) : this.theme.fg('muted', status);
      const current = status === task.status ? this.theme.fg('dim', 'current') : '';
      const row = rightAligned(`  ${marker} ${label}`, current, width);
      lines.push(this.theme.bg(selected ? 'selectedBg' : 'userMessageBg', row));
    }
    return lines;
  }

  /** The subject as an input: a filled field with a caret, as in the mockup. */
  private subjectField(task: Task, width: number): string[] {
    const editing = this.mode === 'subject';
    const value = editing ? `${this.draft}${CURSOR_BLOCK}` : task.subject;
    return [
      this.theme.fg('dim', editing ? SUBJECT_HINT : 'SUBJECT'),
      this.theme.bg(editing ? 'selectedBg' : 'userMessageBg', fitRow(` ${value}`, width)),
    ];
  }

  private detailLines(width: number): string[] {
    const task = this.selectedTask();
    if (!task) return [this.theme.fg('dim', 'No task selected')];

    const editing = this.mode === 'subject' || this.mode === 'status';
    const badge = editing ? this.badge('EDIT', 'toolSuccessBg', 'warning') : '';
    const lines = [rightAligned(this.theme.bold(this.theme.fg('accent', `TASK #${task.id}`)), badge, width), ''];
    lines.push(...this.subjectField(task, width));
    lines.push('', ...this.statusLines(task, width), '');

    if (task.activeForm) lines.push(this.theme.fg('dim', 'ACTIVE FORM'), task.activeForm, '');
    const owner = task.owner ?? task.delegation?.agent ?? NO_VALUE;
    const delegated = task.delegation?.runId ? this.theme.fg('success', `delegated run ${task.delegation.runId}`) : '';
    lines.push(
      this.theme.fg('dim', 'OWNER'),
      delegated ? `${owner}   ${this.theme.fg('dim', '·')}   ${delegated}` : owner,
      '',
    );
    lines.push(
      this.theme.fg('dim', 'BLOCKED BY'),
      task.blockedBy?.length ? task.blockedBy.map((id) => `#${id}`).join(' · ') : NO_VALUE,
    );
    if (task.description) lines.push('', this.theme.fg('dim', 'DESCRIPTION'), ...wrap(task.description, width));
    if (this.notice) lines.push('', this.theme.fg('error', this.notice));
    return lines;
  }

  private headerSummary(): string {
    const counts = countTasks(this.options.store.snapshot.tasks);
    const summary = [`${counts.completed}/${counts.total} completed`];
    if (counts.inProgress > 0) summary.push(`${counts.inProgress} in progress`);
    if (counts.blocked > 0) summary.push(`${counts.blocked} blocked`);
    if (counts.failed > 0) summary.push(`${counts.failed} failed`);
    return summary.join(' · ');
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: `${this.headerSummary()} · ${LIST_HEADER_RIGHT}`,
      footer: this.hintLine(LIST_HINTS),
    };
  }

  protected renderBody(width: number, height: number): string[] {
    this.bodyHeight = height;
    if (width < MIN_WIDTH) return this.renderStacked(width, height);

    const leftWidth = Math.max(MIN_PANE_WIDTH, Math.floor((width - 1) * LIST_PANE_RATIO));
    const rightWidth = Math.max(1, width - leftWidth - 1);
    // Each column gives up one column to the gutter, so content never abuts the
    // divider: a long store path used to run straight into the detail heading.
    const leftContent = Math.max(1, leftWidth - PANE_GUTTER);
    const rightContent = Math.max(1, rightWidth - PANE_GUTTER);
    const left = this.listLines(leftContent);
    const right = this.detailLines(rightContent);

    const divider = this.theme.fg('borderMuted', '│');
    return Array.from({ length: height }, (_, index) => {
      const row = `${fitRow(left[index] ?? '', leftContent)} ${divider} ${fitRow(right[index] ?? '', rightContent)}`;
      return truncateToWidth(row, width, ELLIPSIS);
    });
  }

  private renderStacked(width: number, height: number): string[] {
    const topHeight = Math.max(1, Math.floor((height - 1) / 2));
    const bottomHeight = Math.max(0, height - topHeight - 1);
    this.bodyHeight = topHeight;
    const top = this.listLines(width);
    const bottom = this.detailLines(width);
    return [
      ...top.slice(0, topHeight),
      ...Array.from({ length: Math.max(0, topHeight - top.length) }, () => ''),
      this.theme.fg('borderMuted', '─'.repeat(width)),
      ...bottom.slice(0, bottomHeight),
    ];
  }

  dispose(): void {
    this.unwatch();
  }
}

export async function openTaskSpace(ctx: ExtensionContext, options: TaskSpaceOptions): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new TaskSpaceComponent(tui, theme, options, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
