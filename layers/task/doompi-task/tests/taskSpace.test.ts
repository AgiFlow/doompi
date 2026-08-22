import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTasksCommand } from '../src/exports/commands';
import { TaskStore } from '../src/exports/store/taskStore';
import { STORE_SCHEMA_VERSION, type Task } from '../src/exports/store/types';
import { ERR_REQUIRES_INTERACTIVE, TASK_STATUSES } from '../src/exports/tool/schema';
import { TASK_SPACE_OVERLAY_OPTIONS, TaskSpaceComponent, type TaskSpaceOptions } from '../src/tui/taskSpace.ts';

const WIDTH = 120;
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_ESC = '\x1b';
const KEY_ENTER = '\r';
const SELECTION_MARKER = '›';
/**
 * The breadcrumb ("SPC › t › t / tasks") uses the same glyph as the row marker, so
 * marker assertions must look at body rows only, never the header.
 */
const BREADCRUMB_MARKER = 'SPC ›';
const isSelectedRow = (line: string): boolean => line.includes(SELECTION_MARKER) && !line.includes(BREADCRUMB_MARKER);
const EXTERNAL_POLL_MS = 20;
const EXTERNAL_SETTLE_MS = 200;
let directory: string;
let storePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-task-space-'));
  storePath = path.join(directory, 'tasks.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function seed(tasks: readonly Partial<Task>[]): void {
  const document = {
    version: STORE_SCHEMA_VERSION,
    rev: tasks.length,
    nextId: tasks.length + 1,
    tasks: tasks.map((task, index) => ({
      id: index + 1,
      subject: `task ${index + 1}`,
      status: 'pending',
      ...task,
    })),
  };
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(document), 'utf8');
}

/** Pass-through theme so assertions read plain text, not colour codes. */
function createTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_colour: string, text: string) => text,
    bg: (_colour: string, text: string) => text,
    inverse: identity,
    bold: identity,
    dim: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  } as unknown as Theme;
}

interface Harness {
  component: TaskSpaceComponent;
  store: TaskStore;
  render: () => string[];
  text: () => string;
  closed: () => number;
}

function createComponent(
  options: Omit<Partial<TaskSpaceOptions>, 'store'> & { pollIntervalMs?: number } = {},
): Harness {
  const { pollIntervalMs, ...spaceOptions } = options;
  const store = new TaskStore(pollIntervalMs === undefined ? { storePath } : { storePath, pollIntervalMs });
  store.read();
  const tui = { terminal: { rows: 42, columns: WIDTH }, requestRender: vi.fn() } as unknown as TUI;
  let closeCount = 0;
  const component = new TaskSpaceComponent(tui, createTheme(), { store, ...spaceOptions }, () => {
    closeCount += 1;
  });
  const render = (): string[] => component.render(WIDTH);
  return { component, store, render, text: () => render().join('\n'), closed: () => closeCount };
}

describe('TaskSpaceComponent list panel', () => {
  it('renders each task over two rows so the subject keeps the pane width', () => {
    seed([{ subject: 'Render Task Space overlay via ctx.ui.custom', owner: 'pi', status: 'in_progress' }]);
    const harness = createComponent();

    // Only the list column: the detail pane shares each rendered line.
    const listColumn = (line: string): string => line.split('│')[1] ?? '';
    // Wide enough that the whole subject fits the third-width list pane.
    const lines = harness.component.render(200);
    const heading = lines.findIndex((line) => listColumn(line).includes('Render Task Space overlay via ctx.ui.custom'));

    // Subject survives in full; owner and state moved to the row beneath it.
    expect(heading).toBeGreaterThan(0);
    expect(listColumn(lines[heading] ?? '')).not.toContain('in progress');
    expect(listColumn(lines[heading + 1] ?? '')).toContain('pi');
    expect(listColumn(lines[heading + 1] ?? '')).toContain('in progress');
    harness.component.dispose();
  });

  it('paints key caps, owner chips and a band on every row', () => {
    seed([{ subject: 'first', owner: 'pi' }, { subject: 'second' }]);
    const tagTheme = {
      fg: (colour: string, text: string) => `<${colour}>${text}</>`,
      bg: (colour: string, text: string) => `[bg:${colour}]${text}[/]`,
      inverse: (text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const store = new TaskStore({ storePath });
    store.read();
    const component = new TaskSpaceComponent(
      { terminal: { rows: 42, columns: WIDTH }, requestRender: vi.fn() } as unknown as TUI,
      tagTheme,
      { store },
      vi.fn(),
    );

    // Tag markers are not ANSI, so they count against the fitted width; render
    // wide enough that no row is truncated mid-tag.
    const rendered = component.render(400).join('\n');

    // Footer keys sit in filled caps rather than reading as bare letters.
    expect(rendered).toContain('[bg:selectedBg]<text> ↑↓ </>');
    expect(rendered).toContain('[bg:selectedBg]<text> enter </>');
    // Selected row is a shade lighter than the band the other rows carry.
    expect(rendered).toContain('[bg:selectedBg]');
    expect(rendered).toContain('[bg:userMessageBg]');
    // Owner renders as a chip, not bare text.
    expect(rendered).toContain('[bg:userMessageBg]<muted> pi </>');
    component.dispose();
  });

  it('gives the list a third of the width and keeps a gutter either side of the divider', () => {
    seed([{ subject: 'first' }]);
    const harness = createComponent();

    const row = harness.component.render(150).find((line) => line.includes('SUBJECT')) ?? '';
    // `│ list │ detail │` splits into ['', list, detail, ''].
    const [, listColumn = '', detailColumn = ''] = row.split('│');

    // 150 columns minus the frame, so a third of the body lands near 49.
    expect(listColumn.length).toBeGreaterThan(44);
    expect(listColumn.length).toBeLessThan(56);
    expect(detailColumn.length).toBeGreaterThan(listColumn.length);
    // A blank column each side of the divider, so neither pane touches it.
    expect(listColumn.endsWith(' ')).toBe(true);
    expect(detailColumn.startsWith(' ')).toBe(true);
    harness.component.dispose();
  });

  it('keeps the store file name when the path is too long for the list pane', () => {
    storePath = path.join(directory, 'a'.repeat(80), 'tasks.json');
    seed([{ subject: 'first' }]);
    const harness = createComponent();

    const heading = harness.component.render(150).find((line) => line.includes('TASKS'));

    expect(heading).toContain('tasks.json');
    expect(heading).toContain('…/');
    harness.component.dispose();
  });

  it('renders one row per visible task with glyph, id, subject, owner and state', () => {
    seed([
      { subject: 'write the parser', owner: 'vuong', status: 'in_progress' },
      { subject: 'ship the overlay', owner: 'agent', status: 'pending' },
      { subject: 'obsolete idea', status: 'deleted' },
    ]);
    const harness = createComponent();

    const text = harness.text();
    // Anchored on the row shape (status glyph then id) rather than a bare `#n`:
    // the overlay is a split view, so the detail pane's `TASK #1` heading shares
    // a rendered line with the list and would otherwise count as a row.
    const rows = harness.render().filter((line) => /[○◐✓✗⊘] #[123]\b/.test(line));

    expect(rows).toHaveLength(2);
    expect(text).toContain('write the parser');
    expect(text).toContain('vuong');
    expect(text).toContain('in progress');
    expect(text).not.toContain('obsolete idea');
    harness.component.dispose();
  });

  it('renders a blocked pending row as "blocked by #N" instead of the pending label', () => {
    seed([
      { subject: 'design the schema', status: 'in_progress' },
      { subject: 'wire the migration', status: 'pending', blockedBy: [1] },
      { subject: 'unrelated pending work', status: 'pending' },
    ]);
    const harness = createComponent();

    // The list pane is a third of the width, so a 120-column render truncates
    // these subjects; widen it rather than assert on a clipped row.
    const text = harness.component.render(200).join('\n');
    expect(text).toContain('blocked by #1');
    expect(text).toMatch(/unrelated pending work[\s\S]*pending/);
    harness.component.dispose();
  });

  it('moves the selection marker to exactly one row on arrow navigation', () => {
    seed([{ subject: 'first' }, { subject: 'second' }]);
    const harness = createComponent();

    const before = harness.render().findIndex(isSelectedRow);
    harness.component.handleInput(KEY_DOWN);
    const after = harness.render();

    expect(before).toBeGreaterThanOrEqual(0);
    expect(after.filter(isSelectedRow)).toHaveLength(1);
    expect(after.findIndex(isSelectedRow)).toBeGreaterThan(before);
    harness.component.dispose();
  });

  it('navigates with application-cursor arrows as well as normal-mode ones', () => {
    // Terminals in DECCKM send SS3 (\x1bOA/\x1bOB) rather than CSI, and Pi's
    // kitty-protocol path sends neither; comparing raw CSI strings left the
    // arrow keys dead in a real terminal while tests still passed.
    for (const [up, down] of [
      [KEY_UP, KEY_DOWN],
      ['\x1bOA', '\x1bOB'],
    ]) {
      seed([{ subject: 'first' }, { subject: 'second' }]);
      const harness = createComponent();
      const start = harness.render().findIndex(isSelectedRow);

      harness.component.handleInput(down);
      const moved = harness.render().findIndex(isSelectedRow);
      harness.component.handleInput(up);
      const returned = harness.render().findIndex(isSelectedRow);

      expect(moved).toBeGreaterThan(start);
      expect(returned).toBe(start);
      harness.component.dispose();
    }
  });

  it('renders an empty-state line rather than a blank frame', () => {
    seed([]);
    const harness = createComponent();

    const lines = harness.render();

    expect(lines.some((line) => line.trim().length > 0)).toBe(true);
    harness.component.dispose();
  });

  it('lists exactly the five task statuses in the status picker', () => {
    seed([{ subject: 'pick a status' }]);
    const harness = createComponent();

    harness.component.handleInput('s');
    const text = harness.text();

    for (const status of TASK_STATUSES) expect(text).toContain(status);
    harness.component.dispose();
  });

  it('refreshes rows from an external write without closing', async () => {
    seed([{ subject: 'original subject' }]);
    const harness = createComponent({ pollIntervalMs: EXTERNAL_POLL_MS });
    expect(harness.text()).toContain('original subject');

    seed([{ subject: 'rewritten subject' }]);
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_SETTLE_MS));

    expect(harness.text()).toContain('rewritten subject');
    expect(harness.closed()).toBe(0);
    harness.component.dispose();
  });

  it('closes once on esc', () => {
    seed([{ subject: 'close me' }]);
    const harness = createComponent();

    harness.component.handleInput(KEY_ESC);

    expect(harness.closed()).toBe(1);
    harness.component.dispose();
  });

  it('never creates a task, whatever keys are driven through it', () => {
    seed([{ subject: 'only task' }]);
    const harness = createComponent();
    const before = harness.store.read();

    for (const key of [KEY_DOWN, KEY_UP, 's', KEY_ENTER, 'p', 'r', 'x', 'i', 'm', KEY_ESC]) {
      harness.component.handleInput(key);
    }

    const after = harness.store.read();
    expect(after.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
    // `nextId` is the allocator, so it moves on a create even if the new row
    // were filtered back out of the view.
    expect(after.nextId).toBe(before.nextId);
    harness.component.dispose();
  });

  it('sends every overlay edit as an id-bearing upsert entry', () => {
    seed([{ subject: 'only task' }]);
    const harness = createComponent();
    const mutate = vi.spyOn(harness.store, 'mutate');

    harness.component.handleInput('s');
    harness.component.handleInput(KEY_ENTER);
    harness.component.handleInput(KEY_ENTER);
    harness.component.handleInput('x');
    harness.component.handleInput(KEY_ENTER);

    expect(mutate.mock.calls.length).toBeGreaterThan(0);
    for (const [mutator] of mutate.mock.calls) {
      const probe = { version: 1, rev: 0, nextId: 9, tasks: [] as never[] };
      const outcome = (mutator as (document: typeof probe) => { document?: typeof probe })(probe);
      // An entry with no id would create; against an empty probe document every
      // overlay entry must instead fail to find its task and commit nothing.
      expect(outcome.document).toBeUndefined();
    }
    harness.component.dispose();
  });
});

describe('TaskSpaceComponent editing and layout', () => {
  it('edits a subject inline and persists the commit', async () => {
    seed([{ subject: 'old' }]);
    const harness = createComponent();

    harness.component.handleInput(KEY_ENTER);
    harness.component.handleInput('\x7f');
    harness.component.handleInput('!');
    expect(harness.text()).toContain('EDIT');
    harness.component.handleInput(KEY_ENTER);
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_SETTLE_MS));

    expect(harness.store.read().tasks[0].subject).toBe('ol!');
    harness.component.dispose();
  });

  it('reports a rejected commit instead of persisting it', async () => {
    seed([{ subject: 'keep me' }]);
    const harness = createComponent();

    harness.component.handleInput(KEY_ENTER);
    for (let index = 0; index < 'keep me'.length; index++) harness.component.handleInput('\x7f');
    harness.component.handleInput(KEY_ENTER);
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_SETTLE_MS));

    expect(harness.store.read().tasks[0].subject).toBe('keep me');
    expect(harness.text()).toContain('blank');
    harness.component.dispose();
  });

  it('cancels a subject edit and a status pick on esc without closing', () => {
    seed([{ subject: 'untouched' }]);
    const harness = createComponent();

    harness.component.handleInput(KEY_ENTER);
    harness.component.handleInput('zzz');
    harness.component.handleInput(KEY_ESC);
    harness.component.handleInput('s');
    harness.component.handleInput(KEY_ESC);

    expect(harness.closed()).toBe(0);
    expect(harness.text()).toContain('untouched');
    expect(harness.text()).not.toContain('zzz');
    harness.component.dispose();
  });

  it('cycles the status picker with s and with the arrow keys', () => {
    seed([{ subject: 'cycle me' }]);
    const harness = createComponent();

    harness.component.handleInput('s');
    harness.component.handleInput('s');
    harness.component.handleInput(KEY_DOWN);
    harness.component.handleInput(KEY_UP);

    // The picker marks the task's existing status with a right-aligned "current".
    expect(harness.text()).toContain('current');
    harness.component.dispose();
  });

  it('scrolls the list so the selected row stays visible', () => {
    seed(Array.from({ length: 40 }, (_unused, index) => ({ subject: `task number ${index + 1}` })));
    const harness = createComponent();

    for (let index = 0; index < 39; index++) harness.component.handleInput(KEY_DOWN);
    const lines = harness.render();

    expect(lines.filter(isSelectedRow)).toHaveLength(1);
    expect(lines.join('\n')).toContain('task number 40');
    harness.component.dispose();
  });

  it('renders detail fields and falls back to the delegated agent for the owner', () => {
    seed([
      {
        subject: 'delegated work',
        status: 'in_progress',
        activeForm: 'rendering overlay',
        blockedBy: [2],
        description: 'Open a full-screen overlay from SPC t l using ctx.ui.custom, mirroring openSubagentFleet.',
        delegation: { requestId: 'r1', agent: 'doom-impl', state: 'running' },
      },
      { subject: 'blocker' },
    ]);
    const harness = createComponent();

    const text = harness.text();

    expect(text).toContain('ACTIVE FORM');
    expect(text).toContain('doom-impl');
    expect(text).toContain('#2');
    expect(text).toContain('DESCRIPTION');
    harness.component.dispose();
  });

  it('fills a narrow terminal with a readable stacked view', () => {
    seed([{ subject: 'anything' }]);
    const harness = createComponent();

    const lines = harness.component.render(30);

    expect(lines).toHaveLength(42);
    expect(lines.join('\n')).toContain('TASKS');
    expect(lines.join('\n')).toContain('anything');
    harness.component.dispose();
  });

  it('keeps tab and other unbound keys on the task list', () => {
    seed([{ subject: 'anything' }]);
    const harness = createComponent();

    harness.component.handleInput('\t');
    harness.component.handleInput('q');

    expect(harness.text()).toContain('anything');
    expect(harness.closed()).toBe(0);
    harness.component.dispose();
  });
});

describe('registerTasksCommand overlay dispatch', () => {
  function createPi(): { pi: ExtensionAPI; handler: () => (args: string, ctx: unknown) => Promise<void> } {
    let registered: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        registered = options.handler;
      },
    } as unknown as ExtensionAPI;
    return {
      pi,
      handler: () => {
        if (!registered) throw new Error('tasks command was not registered');
        return registered;
      },
    };
  }

  it('refuses without a UI and never opens the overlay', async () => {
    seed([{ subject: 'anything' }]);
    const store = new TaskStore({ storePath });
    store.read();
    const { pi, handler } = createPi();
    registerTasksCommand(pi, store);
    const custom = vi.fn();
    const notify = vi.fn();

    await handler()('', { hasUI: false, ui: { custom, notify } });

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(ERR_REQUIRES_INTERACTIVE, 'error');
    store.dispose();
  });

  it('opens the Task Space overlay with the shared fleet geometry', async () => {
    seed([{ subject: 'anything' }]);
    const store = new TaskStore({ storePath });
    store.read();
    const { pi, handler } = createPi();
    registerTasksCommand(pi, store);
    const custom = vi.fn();

    await handler()('', { hasUI: true, ui: { custom, notify: vi.fn() } });

    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]?.[1]).toEqual({ overlay: true, overlayOptions: TASK_SPACE_OVERLAY_OPTIONS });
    expect(TASK_SPACE_OVERLAY_OPTIONS).toEqual({
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
      margin: 0,
    });
    store.dispose();
  });
});
